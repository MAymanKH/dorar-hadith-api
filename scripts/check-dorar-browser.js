require('dotenv').config({ quiet: true });
process.env.DORAR_FETCH_MODE = process.argv.includes('--auto')
  ? 'auto'
  : 'browser';

const assert = require('node:assert/strict');
const app = require('../app');
const cache = require('../utils/cache');

const checks = [
  ['money', '/v1/site/hadith/search', { value: 'المال' }],
  ['intentions', '/v1/site/hadith/search', { value: 'إنما الأعمال' }],
  [
    'page 2',
    '/v1/site/hadith/search',
    { value: 'إنما الأعمال', page: 2 },
  ],
  ['prayer', '/v1/site/hadith/search', { value: 'الصلاة' }],
  ['advice', '/v1/site/hadith/search', { value: 'الدين النصيحة' }],
  [
    'specialist',
    '/v1/site/hadith/search',
    { value: 'إنما الأعمال', specialist: true },
  ],
  ['repeat', '/v1/site/hadith/search', { value: 'إنما الأعمال' }],
  [
    'official API',
    '/v1/api/hadith/search',
    { value: 'إنما الأعمال' },
  ],
];

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const [name, path, params] of checks) {
      cache.flushAll();
      const started = Date.now();
      const url = new URL(
        path,
        `http://127.0.0.1:${server.address().port}`,
      );
      url.search = new URLSearchParams(params).toString();
      const response = await fetch(url, {
        signal: AbortSignal.timeout(60000),
      });
      const body = await response.json();
      assert.equal(
        response.status,
        200,
        `${name}: ${body.message || response.statusText}`,
      );
      assert.ok(body.data.length > 0, `${name}: no hadith results`);
      assert.equal(
        body.metadata.isCached,
        false,
        `${name}: expected a fresh upstream request`,
      );
      assert.equal(body.metadata.page, params.page || 1);
      assert.ok(body.data[0].hadith && body.data[0].rawi);
      if (path.includes('/site/')) {
        assert.equal(body.metadata.specialist, !!params.specialist);
        assert.ok(Array.isArray(body.data[0].categories));
      }
      console.log(
        `${name}: HTTP ${response.status}, ${body.data.length} results, ${Date.now() - started} ms`,
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
