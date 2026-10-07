const config = require('../config/config');

module.exports = (res, statusCode, data, metadata) => {
  if (statusCode === 200 && config.cacheEach > 0) {
    res.set('Cache-Control', 'public, max-age=0');
    res.set(
      'Vercel-CDN-Cache-Control',
      `max-age=${config.cacheEach}, stale-while-revalidate=3600`,
    );
  }
  return res.status(statusCode).json({
    status: 'success',
    metadata,
    data,
  });
};
