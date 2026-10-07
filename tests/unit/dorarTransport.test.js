jest.mock(
  '../../services/common/dorarBrowser.service',
  () => ({
    fetchInBrowser: jest.fn(),
  }),
  { virtual: true },
);

const config = require('../../config/config');
const {
  fetchInBrowser,
} = require('../../services/common/dorarBrowser.service');
const fetchWithTimeout = require('../../utils/fetchWithTimeout');

describe('Dorar transport selection', () => {
  let fetchSpy;

  beforeEach(() => {
    config.dorarFetchMode = 'auto';
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Unexpected HTTP request'));
    fetchInBrowser.mockReset();
  });

  afterEach(() => fetchSpy.mockRestore());

  test('a blocked HTTP request falls back to Chromium', async () => {
    fetchSpy.mockResolvedValue(
      new Response('blocked', { status: 403 }),
    );
    fetchInBrowser.mockResolvedValue(new Response('browser results'));
    const response = await fetchWithTimeout(
      'https://www.dorar.net/hadith/search?q=test',
    );
    expect(await response.text()).toBe('browser results');
    expect(fetchInBrowser).toHaveBeenCalledTimes(1);
  });

  test('successful HTTP responses do not launch Chromium', async () => {
    fetchSpy.mockResolvedValue(new Response('HTTP results'));
    const response = await fetchWithTimeout(
      'https://dorar.net/dorar_api.json?skey=test',
    );
    expect(await response.text()).toBe('HTTP results');
    expect(fetchInBrowser).not.toHaveBeenCalled();
  });

  test('browser mode skips HTTP entirely', async () => {
    config.dorarFetchMode = 'browser';
    fetchInBrowser.mockResolvedValue(new Response('browser results'));
    const response = await fetchWithTimeout(
      'https://dorar.net/hadith/search?q=test',
    );
    expect(await response.text()).toBe('browser results');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('HTTP mode preserves the explicit upstream failure', async () => {
    config.dorarFetchMode = 'http';
    fetchSpy.mockResolvedValue(
      new Response('blocked', { status: 403 }),
    );
    await expect(
      fetchWithTimeout('https://dorar.net/hadith/search?q=test'),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(fetchInBrowser).not.toHaveBeenCalled();
  });

  test('an upstream 404 does not cause a browser retry', async () => {
    fetchSpy.mockResolvedValue(
      new Response('missing', { status: 404 }),
    );
    await expect(
      fetchWithTimeout('https://dorar.net/h/missing'),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fetchInBrowser).not.toHaveBeenCalled();
  });

  test('a browser denial stays a gateway failure', async () => {
    fetchSpy.mockResolvedValue(
      new Response('blocked', { status: 403 }),
    );
    fetchInBrowser.mockResolvedValue(
      new Response('still blocked', { status: 403 }),
    );
    await expect(
      fetchWithTimeout('https://dorar.net/hadith/search?q=test'),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(fetchInBrowser).toHaveBeenCalledTimes(1);
  });
});
