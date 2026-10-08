const AppError = require('../../utils/AppError');
const config = require('../../config/config');
const { performance } = require('node:perf_hooks');
const {
  current,
  measure,
  browserResources,
} = require('../../utils/requestTimings');

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
          (sharedUses >= 10 ||
            browserResources(existing).rssMB >= 256))
      ) {
        sharedBrowser = undefined;
        if (healthy)
          await measure('recycle', () => closeBrowser(existing));
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
  const trace = current();
  const strategy =
    trace?.strategy || config.browserStrategy || 'isolated';
  const reuse = strategy === 'reuse';
  let initialResources;
  let release;
  const close = () =>
    (closing ||=
      reuse && !page
        ? Promise.resolve()
        : closeBrowser(browser, reuse ? page : browser));

  try {
    if (reuse)
      release = await measure('queue', () =>
        acquireSlot(
          config.browserFetchTimeout - (Date.now() - started),
        ),
      );
    const [puppeteer, { default: chromium }] = await measure(
      'imports',
      () =>
        Promise.all([
          import('puppeteer-core'),
          import('@sparticuz/chromium'),
        ]),
    );
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
    const executablePath = await measure(
      'extract',
      async () =>
        config.chromiumExecutablePath || (await executablePromise),
    );
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

    browser = await measure('launch', async () => {
      if (!reuse) return launch();
      return getSharedBrowser(launch);
    });
    initialResources = reuse
      ? browserResources(browser)
      : { cpuMs: 0 };
    if (trace?.onBrowser) trace.onBrowser(browser);

    timer = setTimeout(() => {
      timedOut = true;
      close().catch(() => {});
    }, remaining());

    page = await measure('page', () => browser.newPage());
    const setupStarted = performance.now();
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
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const navigation =
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame();
      return (
        navigation ? request.continue() : request.abort()
      ).catch(() => {});
    });
    if (trace)
      trace.stages.push({
        name: 'setup',
        ms: performance.now() - setupStarted,
      });
    const navigationStarted = performance.now();
    page.on('response', (response) => {
      if (
        trace &&
        response.status() === 200 &&
        response.request().isNavigationRequest() &&
        response.request().frame() === page.mainFrame()
      ) {
        trace.stages.push({
          name: 'headers',
          ms: performance.now() - navigationStarted,
        });
      }
    });
    const response = await measure('navigate', () =>
      page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      }),
    );
    const body = await measure('body', () => response.buffer());
    if (trace) {
      const resources = browserResources(browser);
      trace.chromeRssMB = Math.max(
        trace.chromeRssMB || 0,
        resources.rssMB,
      );
      trace.chromeCpuMs =
        (trace.chromeCpuMs || 0) +
        Math.max(0, resources.cpuMs - initialResources.cpuMs);
    }
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
      const cleanup = measure('cleanup', () =>
        close().catch(() => {}),
      );
      if (strategy === 'background' && succeeded && !timedOut) {
        if (trace?.background) trace.background.push(cleanup);
        else if (process.env.VERCEL) {
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
