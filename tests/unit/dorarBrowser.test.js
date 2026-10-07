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
    ({
      fetchInBrowser,
    } = require('../../services/common/dorarBrowser.service'));
    page = {
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
});
