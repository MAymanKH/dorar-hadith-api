module.exports = (app) => {
  if (process.env.DORAR_BENCHMARK !== '1') return;
  const {
    matrix,
    sample,
    cacheAndPrefetch,
    concurrent,
    recovery,
    recycling,
  } = require('./benchmark-dorar');
  app.get('/__benchmark', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      let result;
      if (req.query.test === 'sample')
        result = await sample(
          req.query.workflow || 'search',
          'reuse',
        );
      else if (req.query.test === 'cache')
        result = await cacheAndPrefetch();
      else if (req.query.test === 'concurrent')
        result = await concurrent(req.query.deduplicate !== 'false');
      else if (req.query.test === 'recovery')
        result = await recovery();
      else if (req.query.test === 'recycling')
        result = await recycling();
      else
        result = await matrix(
          req.query.workflow || 'search',
          Number(req.query.round || 0),
        );
      res.json({
        region: process.env.VERCEL_REGION,
        memoryMB:
          Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE) ||
          undefined,
        node: process.version,
        result,
      });
    } catch (error) {
      next(error);
    }
  });
};
