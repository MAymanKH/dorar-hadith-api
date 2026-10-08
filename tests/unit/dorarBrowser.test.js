jest.unstable_mockModule('puppeteer-core', () => ({
  launch: jest.fn(),
  TimeoutError: class TimeoutError extends Error {
    constructor(message) {
      super(message);
      this.name = 'TimeoutError';
    }
  },
}));
jest.unstable_mockModule('@sparticuz/chromium', () => ({
  default: {
    args: ['--no-sandbox'],
    executablePath: jest.fn(),
  },
}));

jest.unstable_mockModule('@vercel/functions', () => ({
  waitUntil: jest.fn(),
}));

describe('Chromium response and process lifecycle', () => {
  let puppeteer;
  let chromium;
  let config;
  let fetchInBrowser;
  let page;
  let browser;

  beforeEach(async () => {
    jest.resetModules();
    puppeteer = await import('puppeteer-core');
    chromium = (await import('@sparticuz/chromium')).default;
    config = require('../../config/config');
    config.chromiumExecutablePath = '/test/chromium';
    config.dorarProxyUrl = undefined;
    config.fetchTimeout = 1000;
    config.browserFetchTimeout = 1000;
    config.browserStrategy = 'isolated';
    ({
      fetchInBrowser,
    } = require('../../services/common/dorarBrowser.service'));
    page = {
      close: jest.fn().mockResolvedValue(),
      setRequestInterception: jest.fn(),
      on: jest.fn(),
      mainFrame: () => 'main-frame',
      setUserAgent: jest.fn(),
      authenticate: jest.fn(),
      setExtraHTTPHeaders: jest.fn(),
      goto: jest.fn().mockResolvedValue({
        status: () => 200,
        statusText: () => 'OK',
        buffer: async () => Buffer.from('browser results'),
        headers: () => ({
          'content-type': 'text/html',
          'content-encoding': 'gzip',
          'content-length': '5',
          'set-cookie': 'first=test; Path=/\nsecond=test; Path=/',
          vary: 'Accept-Encoding\nAccept-Language',
        }),
      }),
    };
    browser = {
      connected: true,
      version: jest.fn().mockResolvedValue('Chrome/153'),
      newPage: jest.fn().mockResolvedValue(page),
      userAgent: async () => 'HeadlessChrome/153.0.0.0',
      close: jest.fn().mockResolvedValue(),
    };
    puppeteer.launch.mockResolvedValue(browser);
    chromium.executablePath.mockResolvedValue('/tmp/chromium');
  });

  test('returns decoded content without leaking browser cookies or compressed body headers', async () => {
    const response = await fetchInBrowser(
      'https://dorar.net/hadith/search?q=test',
    );
    expect(await response.text()).toBe('browser results');
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('vary')).toBe(
      'Accept-Encoding, Accept-Language',
    );
    expect(page.setUserAgent).toHaveBeenCalledWith(
      'Chrome/153.0.0.0',
    );
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('closes Chromium when navigation fails', async () => {
    page.goto.mockRejectedValue(new Error('navigation failed'));
    await expect(
      fetchInBrowser('https://dorar.net/hadith/search?q=test'),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('loads main navigation and redirects while skipping page assets and iframes', async () => {
    await fetchInBrowser('https://dorar.net/hadith/search?q=test');
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
    const intercept = page.on.mock.calls.find(
      ([event]) => event === 'request',
    )[1];
    for (const [navigation, frame, allowed] of [
      [true, 'main-frame', true],
      [false, 'main-frame', false],
      [true, 'iframe', false],
    ]) {
      const request = {
        isNavigationRequest: () => navigation,
        frame: () => frame,
        continue: jest.fn().mockResolvedValue(),
        abort: jest.fn().mockResolvedValue(),
      };
      await intercept(request);
      expect(request.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(request.abort).toHaveBeenCalledTimes(allowed ? 0 : 1);
    }
  });

  test('a stalled navigation closes Chromium and returns a timeout', async () => {
    config.fetchTimeout = 30;
    config.browserFetchTimeout = 30;
    let rejectNavigation;
    page.goto.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          rejectNavigation = reject;
        }),
    );
    browser.close.mockImplementation(async () => {
      rejectNavigation(new Error('Target closed'));
    });
    await expect(
      fetchInBrowser('https://dorar.net/hadith/search?q=test'),
    ).rejects.toMatchObject({ statusCode: 408 });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('cold startup uses the browser budget and leaves only the remaining time for launch', async () => {
    config.chromiumExecutablePath = undefined;
    config.fetchTimeout = 15000;
    config.browserFetchTimeout = 40000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(0);
    chromium.executablePath.mockImplementation(async () => {
      clock.mockReturnValue(16000);
      return '/tmp/chromium';
    });
    try {
      const response = await fetchInBrowser(
        'https://dorar.net/hadith/search?q=test',
      );
      expect(response.status).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 24000 }),
      );
    } finally {
      clock.mockRestore();
    }
  });

  test('a stalled shutdown kills the child process and still returns the result', async () => {
    let finishClose;
    browser.close.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishClose = resolve;
        }),
    );
    const kill = jest.fn(() => {
      finishClose();
      return true;
    });
    browser.process = () => ({ kill });
    const response = await fetchInBrowser(
      'https://dorar.net/hadith/search?q=test',
    );
    expect(response.status).toBe(200);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  }, 4000);

  test('extracts the serverless binary once but isolates requests in separate browsers', async () => {
    config.chromiumExecutablePath = undefined;
    await fetchInBrowser('https://dorar.net/hadith/search?q=first');
    await fetchInBrowser('https://dorar.net/hadith/search?q=second');
    expect(chromium.executablePath).toHaveBeenCalledTimes(1);
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(puppeteer.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '/tmp/chromium',
        headless: 'shell',
      }),
    );
  });

  test('a failed extraction can be retried by the next request', async () => {
    config.chromiumExecutablePath = undefined;
    chromium.executablePath.mockRejectedValueOnce(
      new Error('extraction failed'),
    );
    await expect(
      fetchInBrowser('https://dorar.net/hadith/search?q=first'),
    ).rejects.toMatchObject({ statusCode: 502 });
    const response = await fetchInBrowser(
      'https://dorar.net/hadith/search?q=second',
    );
    expect(response.status).toBe(200);
    expect(chromium.executablePath).toHaveBeenCalledTimes(2);
  });

  test('proxy credentials stay out of Chromium launch arguments', async () => {
    config.dorarProxyUrl =
      'http://proxy-user:proxy-password@proxy.example:8080';
    await fetchInBrowser('https://dorar.net/hadith/search?q=test');
    expect(puppeteer.launch.mock.calls[0][0].args).toContain(
      '--proxy-server=http://proxy.example:8080',
    );
    expect(
      puppeteer.launch.mock.calls[0][0].args.join(' '),
    ).not.toContain('proxy-password');
    expect(page.authenticate).toHaveBeenCalledWith({
      username: 'proxy-user',
      password: 'proxy-password',
    });
  });

  test('rejects arbitrary hosts before launching a browser', async () => {
    await expect(
      fetchInBrowser('https://example.com/'),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(puppeteer.launch).not.toHaveBeenCalled();
  });

  test('Vercel background cleanup returns the body before closing finishes', async () => {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil.mockReset();
    const previous = process.env.VERCEL;
    process.env.VERCEL = '1';
    config.browserStrategy = 'background';
    let finish;
    browser.close.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const response = await fetchInBrowser(
        'https://dorar.net/h/test',
      );
      expect(await response.text()).toBe('browser results');
      expect(waitUntil).toHaveBeenCalledTimes(1);
      finish();
      await waitUntil.mock.calls[0][0];
    } finally {
      if (previous === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previous;
    }
  });

  test('reuses a connected browser and closes each request page', async () => {
    config.browserStrategy = 'reuse';
    await fetchInBrowser('https://dorar.net/h/first');
    await fetchInBrowser('https://dorar.net/h/second');
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
    expect(page.close).toHaveBeenCalledTimes(2);
    expect(browser.close).not.toHaveBeenCalled();
    browser.connected = false;
    await fetchInBrowser('https://dorar.net/h/third');
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  });

  test('a reused page timeout closes that page without closing the shared browser', async () => {
    config.browserStrategy = 'reuse';
    config.browserFetchTimeout = 30;
    let reject;
    page.goto.mockImplementation(
      () =>
        new Promise((resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    page.close.mockImplementation(async () =>
      reject(new Error('page closed')),
    );
    await expect(
      fetchInBrowser('https://dorar.net/h/stalled'),
    ).rejects.toMatchObject({ statusCode: 408 });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
  });

  test('recycles an idle shared browser after ten uses', async () => {
    config.browserStrategy = 'reuse';
    for (let i = 0; i < 11; i++)
      await fetchInBrowser(`https://dorar.net/h/${i}`);
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('a browser that stops responding is killed and replaced', async () => {
    config.browserStrategy = 'reuse';
    await fetchInBrowser('https://dorar.net/h/first');
    browser.version.mockRejectedValueOnce(
      new Error('closed connection'),
    );
    const kill = jest.fn();
    browser.process = () => ({ kill });
    await fetchInBrowser('https://dorar.net/h/second');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  });

  test('limits shared-browser work to two simultaneous pages', async () => {
    config.browserStrategy = 'reuse';
    const response = await page.goto();
    const opened = [];
    browser.newPage.mockImplementation(async () => {
      let finish;
      const next = {
        ...page,
        close: jest.fn().mockResolvedValue(),
        goto: jest.fn(
          () =>
            new Promise((resolve) => {
              finish = () => resolve(response);
            }),
        ),
      };
      opened.push({ next, finish: () => finish() });
      return next;
    });
    const requests = [0, 1, 2].map((i) =>
      fetchInBrowser(`https://dorar.net/h/parallel${i}`),
    );
    for (let i = 0; i < 20 && opened.length < 2; i++)
      await new Promise(setImmediate);
    expect(opened).toHaveLength(2);
    opened[0].finish();
    for (let i = 0; i < 20 && opened.length < 3; i++)
      await new Promise(setImmediate);
    expect(opened).toHaveLength(3);
    opened[1].finish();
    opened[2].finish();
    await Promise.all(requests);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
  });
});
