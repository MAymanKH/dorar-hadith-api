jest.mock('../../services/common/dorarFetch.service', () => ({ fetchDocument: jest.fn(), fetchDecodedJsonBody: jest.fn() }));
const request = require('supertest');
const { parseHTML } = require('linkedom');
const { fetchDocument } = require('../../services/common/dorarFetch.service');
const cache = require('../../utils/cache');
const app = require('../../app');
const html = `<a aria-controls="home">(60)</a><div id="home">${[
  ['one', '[عمر بن الخطاب]', '256', '6216'],
  ['two', 'ابن عباس', '261', '3088'],
  ['three', 'عمر بن الخطاب وأبو هريرة', '256', '6216'],
].map(([id, rawi, scholar, book]) => `<div class="border-bottom"><article><h5>1 - text ${id}</h5></article><div>
<strong>الراوي: <span>${rawi}</span></strong>
<a view-card="mhd" card-link="/hadith/mhd/${scholar}"></a><a view-card="book" card-link="/hadith/book-card/${book}"></a>
<a tag="${id}" href="https://dorar.net/h/${id}"></a></div></div>`).join('')}</div>`;

beforeEach(() => { cache.flushAll(); fetchDocument.mockReset().mockResolvedValue(parseHTML(html).document); });

test('compact narrator exclusions preserve order, group labels and upstream pagination', async () => {
  const result = await request(app).get('/v1/site/hadith/search').query({ value: 'test', 'xrawi[]': '8918' });
  expect(result.status).toBe(200);
  expect(result.body.data.map((item) => item.hadithId)).toEqual(['two', 'three']);
  expect(result.body.metadata).toMatchObject({ page: 1, hasNextPage: true, exclusionsApplied: true, upstreamTotal: 60, currentPageCount: 2 });
  expect(result.body.metadata.total).toBeUndefined();
  expect(fetchDocument.mock.calls[0][0]).not.toContain('xrawi');
  expect(fetchDocument.mock.calls[0][0].length).toBeLessThan(300);
});

test('unfiltered cached pages can serve different exclusions without cross-contamination', async () => {
  const ordinary = await request(app).get('/v1/site/hadith/search').query({ value: 'test' });
  const filtered = await request(app).get('/v1/site/hadith/search').query({ value: 'test', 'xs[]': '6216' });
  expect(ordinary.body.data).toHaveLength(3);
  expect(filtered.body.data.map((item) => item.hadithId)).toEqual(['two']);
  expect(filtered.body.metadata.isCached).toBe(true);
  expect(fetchDocument).toHaveBeenCalledTimes(1);
});

test('empty filtered pages still advertise remaining upstream pages', async () => {
  const response = await request(app).get('/v1/site/hadith/search').query({ value: 'test', 'xm[]': ['256', '261'] });
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual([]);
  expect(response.body.metadata.hasNextPage).toBe(true);
});

test.each([
  { 'xrawi[]': 'not-an-id' }, { 'xrawi[]': '0' }, { 'xrawi[]': '999999999' },
  { 'xs[]': '6216', 's[]': '3088' },
])('invalid or conflicting exclusions fail before contacting Dorar: %j', async (filters) => {
  const response = await request(app).get('/v1/site/hadith/search').query({ value: 'test', ...filters });
  expect(response.status).toBe(400);
  expect(fetchDocument).not.toHaveBeenCalled();
});
