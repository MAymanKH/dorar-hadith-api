const AppError = require('../../utils/AppError');
const config = require('../../config/config');

let executablePromise;

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
  let timer;
  let closing;
  let timedOut = false;
  const kill = () => {
    try {
      browser.process()?.kill('SIGKILL');
    } catch {}
  };
  const close = () =>
    (closing ||= (async () => {
      let killTimer;
      try {
        await Promise.race([
          browser.close().catch(kill),
          new Promise((resolve) => {
            killTimer = setTimeout(() => {
              kill();
              resolve();
            }, 2000);
          }),
        ]);
      } finally {
        clearTimeout(killTimer);
      }
    })());

  try {
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

    browser = await puppeteer.launch({
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

    timer = setTimeout(() => {
      timedOut = true;
      close().catch(() => {});
    }, remaining());

    const page = await browser.newPage();
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
    if (browser) await close().catch(() => {});
  }
};

module.exports = { fetchInBrowser };
