const config = require('../config/config');
const { header } = require('./requestTimings');

module.exports = (res, statusCode, data, metadata) => {
  const timings = header();
  if (timings) res.set('Server-Timing', timings);
  const ttl = res.req?.params?.id
    ? config.cacheStableEach
    : config.cacheEach;
  if (statusCode === 200 && ttl > 0) {
    res.set('Cache-Control', 'public, max-age=0');
    res.set(
      'Vercel-CDN-Cache-Control',
      `max-age=${ttl}, stale-while-revalidate=3600`,
    );
  }
  return res.status(statusCode).json({
    status: 'success',
    metadata,
    data,
  });
};
