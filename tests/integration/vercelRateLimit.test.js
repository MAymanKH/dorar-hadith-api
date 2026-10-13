const request = require('supertest');
const previous = process.env.VERCEL;
process.env.VERCEL = '1';
require('../../config/config').rateLimitMax = 1;
const app = require('../../app');

afterAll(() => {
  if (previous === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = previous;
});

test('Vercel visitors have separate rate limits instead of sharing the proxy IP', async () => {
  const first = await request(app).get('/v1/site/hadith/search').set('X-Forwarded-For', '192.0.2.1');
  const second = await request(app).get('/v1/site/hadith/search').set('X-Forwarded-For', '192.0.2.2');
  const limited = await request(app).get('/v1/site/hadith/search').set('X-Forwarded-For', '192.0.2.1');
  expect(first.status).toBe(400);
  expect(second.status).toBe(400);
  expect(limited.status).toBe(429);
});
