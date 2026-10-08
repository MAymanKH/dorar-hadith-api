jest.mock('../../services/common/dorarFetch.service', () => ({
  fetchDocument: jest.fn(),
  fetchDecodedJsonBody: jest.fn(),
}));

const request = require('supertest');
const { parseHTML } = require('linkedom');
const {
  fetchDocument,
} = require('../../services/common/dorarFetch.service');
const hadith = require('../../services/dorar/hadithSearch.service');
const sharh = require('../../services/dorar/sharhSearch.service');
const cache = require('../../utils/cache');
const config = require('../../config/config');
const app = require('../../app');

const searchHtml = `<a aria-controls="home">(1)</a>
  <div id="home"><div class="border-bottom">
    <article><h5>1 - hadith text</h5></article>
    <div><strong>الراوي : <span>rawi</span></strong>
      <a xplain="123"></a><a tag="abc123" href="https://dorar.net/h/abc123"></a>
    </div>
  </div></div>`;
const sharhHtml = `<article><h5>hadith text</h5></article>
  <strong>خلاصة حكم المحدث: <span class="primary-text-color">sahih</span></strong>
  <strong>الراوي: <span class="primary-text-color">rawi</span></strong>
  <a tag="abc123" href="https://dorar.net/hadith/sharh/123"></a>
  <div class="text-justify">heading</div><div>explanation text</div>`;

beforeEach(() => {
  cache.flushAll();
  config.cacheEach = 300;
  fetchDocument
    .mockReset()
    .mockImplementation(
      async (url) =>
        parseHTML(
          url.includes('/hadith/sharh/') ? sharhHtml : searchHtml,
        ).document,
    );
});

const options = {
  queryParams: { value: 'test' },
  tab: 'home',
  isForSpecialist: false,
  isRemoveHTML: true,
};

test('cached searches preserve the requested HTML format', async () => {
  const plain = await hadith.searchUsingSiteDorar(options);
  const html = await hadith.searchUsingSiteDorar({
    ...options,
    isRemoveHTML: false,
  });
  expect(plain.data[0].hadith).toBe('hadith text');
  expect(html.data[0].hadith).toContain('<h5>');
  expect(html.metadata.removeHTML).toBe(false);
  expect((await hadith.searchUsingSiteDorar(options)).isCached).toBe(
    true,
  );
});

test('hadith results never substitute for sharh results at the same upstream URL', async () => {
  await hadith.searchUsingSiteDorar(options);
  const result = await sharh.getAllSharhUsingSiteDorar(options);
  expect(result.data[0].sharhMetadata.sharh).toBe('explanation text');
  expect(result.isCached).toBe(false);
});

test('a single explanation never substitutes a cached list of explanations', async () => {
  await sharh.getAllSharhUsingSiteDorar(options);
  const result = await sharh.getOneSharhByTextUsingSiteDorar({
    text: 'test',
    tab: 'home',
    isForSpecialist: false,
  });
  expect(result.data.sharhMetadata.sharh).toBe('explanation text');
});

test('successful public searches opt into CDN caching while errors do not', async () => {
  const success = await request(app)
    .get('/v1/site/hadith/search')
    .query({ value: 'test' });
  expect(success.status).toBe(200);
  expect(success.headers['vercel-cdn-cache-control']).toBe(
    'max-age=300, stale-while-revalidate=3600',
  );
  const invalid = await request(app).get('/v1/site/hadith/search');
  expect(invalid.status).toBe(400);
  expect(invalid.headers['vercel-cdn-cache-control']).toBeUndefined();
});

test('upstream failures are never cached as successful responses', async () => {
  const AppError = require('../../utils/AppError');
  fetchDocument.mockRejectedValueOnce(
    new AppError('upstream unavailable', 502),
  );
  const response = await request(app)
    .get('/v1/site/hadith/search')
    .query({ value: 'test' });
  expect(response.status).toBe(502);
  expect(
    response.headers['vercel-cdn-cache-control'],
  ).toBeUndefined();
});

test('explanations by ID are retained for a day while searches retain five-minute caching', async () => {
  config.cacheStableEach = 86400;
  const response = await request(app).get('/v1/site/sharh/123');
  expect(response.status).toBe(200);
  expect(response.headers['vercel-cdn-cache-control']).toBe(
    'max-age=86400, stale-while-revalidate=3600',
  );
  const remaining =
    cache.getTtl('https://www.dorar.net/hadith/sharh/123') -
    Date.now();
  expect(remaining).toBeGreaterThan(86399000);
  expect(remaining).toBeLessThanOrEqual(86400000);
});

test('sharh pages parse labels rather than relying on field order', async () => {
  const response = await sharh.getOneSharhByIdUsingSiteDorar({
    sharhId: '123',
  });
  expect(response.data.rawi).toBe('rawi');
  expect(response.data.grade).toBe('sahih');
  expect(response.data.hadithId).toBe('abc123');
});

test('the app sharh filter resolves explanation cards to complete hadiths', async () => {
  fetchDocument.mockImplementation(
    async (url) =>
      parseHTML(
        url.includes('/hadith/sharh/')
          ? sharhHtml
          : '<div id="cntnt"><article><a href="/hadith/sharh/123"><h5>preview</h5></a></article></div><div id="results-end" page="1"></div>',
      ).document,
  );
  const queryParams = { value: 'test', t: '3' };
  const response = await hadith.searchUsingSiteDorar({
    ...options,
    queryParams,
  });
  expect(response.data).toHaveLength(1);
  expect(response.data[0].hadithId).toBe('abc123');
  expect(response.data[0].rawi).toBe('rawi');
  expect(response.data[0].grade).toBe('sahih');
  expect(response.data[0].sharhMetadata.sharh).toBe(
    'explanation text',
  );
  expect(response.metadata.hasNextPage).toBe(false);
  const html = await hadith.searchUsingSiteDorar({
    ...options,
    queryParams,
    isRemoveHTML: false,
  });
  expect(html.data[0].hadith).toContain('<h5>hadith text</h5>');
  expect(html.metadata.removeHTML).toBe(false);
});
