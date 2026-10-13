const AppError = require('../../utils/AppError');
const config = require('../../config/config');

let executablePromise;
let sharedBrowser;
let poolOperation = Promise.resolve();
let sharedUses = 0;
let activeSharedPages = 0;
let occupiedSlots = 0;
const waiting = [];

const killBrowser = (browser) => {
  try {
    browser.process()?.kill('SIGKILL');
  } catch {}
};

const closeBrowser = async (browser, target = browser) => {
  let timer;
  try {
    await Promise.race([
      target.close().catch(() => killBrowser(browser)),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          killBrowser(browser);
          resolve();
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// Best-effort resident memory of the browser process, used to recycle
// long-lived instances before they grow without bound.
const browserRssMB = (browser) => {
  try {
    const pid = browser.process().pid;
    const status = require('node:fs').readFileSync(
      `/proc/${pid}/status`,
      'utf8',
    );
    return Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0) / 1024;
  } catch {
    return 0;
  }
};

const releaseSlot = () => {
  occupiedSlots--;
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    occupiedSlots++;
    next.resolve(releaseSlot);
  }
};

const acquireSlot = (timeout) => {
  if (timeout <= 0)
    return Promise.reject(
      new AppError(
        'Chromium request timeout. Please try again later.',
        408,
      ),
    );
  if (occupiedSlots < 2) {
    occupiedSlots++;
    return Promise.resolve(releaseSlot);
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve };
    entry.timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(entry), 1);
      reject(
        new AppError(
          'Chromium request timeout. Please try again later.',
          408,
        ),
      );
    }, timeout);
    waiting.push(entry);
  });
};

const getSharedBrowser = (launch) => {
  const operation = poolOperation.then(async () => {
    if (sharedBrowser) {
      const existing = await sharedBrowser;
      let healthy = existing.connected;
      if (healthy) {
        let timer;
        try {
          await Promise.race([
            existing.version(),
            new Promise((resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('Browser stopped responding')),
                2000,
              );
            }),
          ]);
        } catch {
          healthy = false;
          killBrowser(existing);
        } finally {
          clearTimeout(timer);
        }
      }
      if (
        !healthy ||
        (!activeSharedPages &&
          (sharedUses >= 10 || browserRssMB(existing) >= 256))
      ) {
        sharedBrowser = undefined;
        if (healthy) await closeBrowser(existing);
      }
    }
    if (!sharedBrowser) {
      sharedUses = 0;
      sharedBrowser = launch().catch((error) => {
        sharedBrowser = undefined;
        throw error;
      });
    }
    const browser = await sharedBrowser;
    sharedUses++;
    activeSharedPages++;
    return browser;
  });
  poolOperation = operation.catch(() => {});
  return operation;
};

const fetchInBrowser = async (url, options = {}) => {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    !['dorar.net', 'www.dorar.net'].includes(target.hostname)
  ) {
    throw new AppError('Invalid Dorar browser URL', 502);
  }

  const started = Date.now();
  let browser;
  let page;
  let timer;
  let closing;
  let timedOut = false;
  let succeeded = false;
  const strategy = config.browserStrategy || 'reuse';
  const reuse = strategy === 'reuse';
  let release;
  const close = () => {
    if (reuse && !page) return Promise.resolve();
    return (closing ||= closeBrowser(browser, reuse ? page : browser));
  };

  try {
    if (reuse)
      release = await acquireSlot(
        config.browserFetchTimeout - (Date.now() - started),
      );
    const [puppeteer, { default: chromium }] = await Promise.all([
      import('puppeteer-core'),
      import('@sparticuz/chromium'),
    ]);
    const remaining = () => {
      const time =
        config.browserFetchTimeout - (Date.now() - started);
      if (time <= 0)
        throw new puppeteer.TimeoutError(
          'Chromium request exceeded BROWSER_FETCH_TIMEOUT',
        );
      return time;
    };
    if (!config.chromiumExecutablePath && !executablePromise) {
      executablePromise = chromium.executablePath().catch((error) => {
        executablePromise = undefined;
        throw error;
      });
    }
    const executablePath =
      config.chromiumExecutablePath || (await executablePromise);
    const args = config.chromiumExecutablePath
      ? ['--no-sandbox', '--disable-dev-shm-usage']
      : chromium.args;
    const proxy = config.dorarProxyUrl
      ? new URL(config.dorarProxyUrl)
      : undefined;

    const launch = () =>
      puppeteer.launch({
        executablePath,
        headless: config.chromiumExecutablePath ? true : 'shell',
        args: [
          ...args,
          '--disable-blink-features=AutomationControlled',
          ...(proxy ? [`--proxy-server=${proxy.origin}`] : []),
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: remaining(),
        protocolTimeout: config.browserFetchTimeout,
      });

    browser = reuse ? await getSharedBrowser(launch) : await launch();

    timer = setTimeout(() => {
      timedOut = true;
      close().catch(() => {});
    }, remaining());

    page = await browser.newPage();
    remaining();
    await page.setUserAgent(
      (await browser.userAgent()).replace('HeadlessChrome', 'Chrome'),
    );
    if (proxy?.username || proxy?.password) {
      await page.authenticate({
        username: decodeURIComponent(proxy.username),
        password: decodeURIComponent(proxy.password),
      });
    }
    if (options.headers) {
      await page.setExtraHTTPHeaders(
        Object.fromEntries(new Headers(options.headers)),
      );
    }
    // The API parses hadith content already present in the HTML, so
    // only the main document and its redirects are loaded. Scripts,
    // styles, images, and frames are skipped.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const navigation =
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame();
      return (
        navigation ? request.continue() : request.abort()
      ).catch(() => {});
    });
    const response = await page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: remaining(),
    });
    const body = await response.buffer();
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers())) {
      if (
        ['set-cookie', 'content-encoding', 'content-length'].includes(
          name,
        )
      )
        continue;
      headers.set(name, value.replace(/[\r\n]+/g, ', '));
    }
    succeeded = true;
    return new Response(
      [204, 205, 304].includes(response.status()) ? null : body,
      {
        status: response.status(),
        statusText: response.statusText(),
        headers,
      },
    );
  } catch (error) {
    if (timedOut || error.name === 'TimeoutError') {
      throw new AppError(
        'Chromium request timeout. Please try again later.',
        408,
      );
    }
    throw new AppError(
      'Unable to fetch Dorar with Chromium. Check CHROMIUM_EXECUTABLE_PATH and browser dependencies.',
      502,
    );
  } finally {
    clearTimeout(timer);
    if (browser) {
      // The background strategy returns the response first and lets
      // Vercel finish closing Chromium via waitUntil, so shutdown
      // never eats into the response budget on serverless.
      const cleanup = close().catch(() => {});
      if (strategy === 'background' && succeeded && !timedOut) {
        if (process.env.VERCEL) {
          try {
            const { waitUntil } = await import('@vercel/functions');
            waitUntil(cleanup);
          } catch {
            await cleanup;
          }
        } else await cleanup;
      } else await cleanup;
    }
    if (reuse && browser) activeSharedPages--;
    if (release) release();
  }
};

const closeSharedBrowser = async () => {
  await poolOperation;
  const pending = sharedBrowser;
  sharedBrowser = undefined;
  if (pending) await closeBrowser(await pending);
};

module.exports = { fetchInBrowser, closeSharedBrowser };
