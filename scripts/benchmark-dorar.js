const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { run } = require('../utils/requestTimings');
const cache = require('../utils/cache');
const hadith = require('../services/dorar/hadithSearch.service');
const sharh = require('../services/dorar/sharhSearch.service');
const {
  closeSharedBrowser,
} = require('../services/common/dorarBrowser.service');

const actions = {
  search: () =>
    hadith.searchUsingSiteDorar({
      queryParams: {
        value: 'المال',
        page: 1,
        st: 'a',
        t: '*',
        'd[]': 0,
        'm[]': 0,
        's[]': 0,
      },
      tab: 'home',
      isRemoveHTML: true,
      isForSpecialist: false,
    }),
  sharhSearch: () =>
    hadith.searchUsingSiteDorar({
      queryParams: {
        value: 'المال',
        page: 1,
        st: 'a',
        t: '3',
        'd[]': 0,
        'm[]': 0,
        's[]': 0,
      },
      tab: 'home',
      isRemoveHTML: true,
      isForSpecialist: false,
    }),
  sharh: () =>
    sharh.getOneSharhByIdUsingSiteDorar({ sharhId: '10301' }),
  similar: () =>
    hadith.getAllSimilarHadithUsingSiteDorar({
      similarId: 'CxhuYTbO',
    }),
  details: () =>
    hadith.getOneHadithUsingSiteDorarById({ hadithId: 'CxhuYTbO' }),
};

const sample = async (workflow, strategy) => {
  const action = actions[workflow];
  assert.ok(action, 'Unknown benchmark workflow');
  cache.flushAll();
  const result = await run(action, { strategy });
  const data = result.value.data;
  const first = Array.isArray(data) ? data[0] : data;
  assert.ok(
    first?.hadith && first?.rawi,
    'Incomplete hadith results',
  );
  if (workflow === 'sharh')
    assert.ok(first.sharhMetadata?.sharh, 'Missing explanation');
  const count = Array.isArray(data) ? data.length : 1;
  delete result.value;
  return { workflow, strategy, count, ...result };
};

const matrix = async (workflow, round = 0) => {
  const order =
    round % 2
      ? ['reuse', 'background', 'isolated']
      : ['isolated', 'background', 'reuse'];
  const samples = [];
  for (const strategy of order)
    samples.push(await sample(workflow, strategy));
  return samples;
};

const cacheAndPrefetch = async () => {
  cache.flushAll();
  const first = await run(actions.sharh, { strategy: 'background' });
  const saved = await run(actions.sharh, { strategy: 'background' });
  assert.equal(saved.value.isCached, true);
  assert.equal(saved.stages.length, 0);
  return {
    firstMs: first.responseReadyMs,
    savedMs: saved.responseReadyMs,
    prefetchReadyAtMs: first.responseReadyMs,
    tapAfter5SecondsWaitMs:
      first.responseReadyMs <= 5000
        ? saved.responseReadyMs
        : first.responseReadyMs - 5000,
    wastedRequestsIfNeverOpened: 1,
  };
};

const concurrent = async (deduplicate) => {
  await closeSharedBrowser();
  cache.flushAll();
  const result = await run(
    () =>
      Promise.all([
        actions.search(),
        actions.search(),
        actions.search(),
      ]),
    {
      strategy: 'background',
      deduplicate,
    },
  );
  for (const response of result.value)
    assert.ok(response.data[0]?.hadith);
  const browsers = result.stages.filter(
    (s) => s.name === 'launch',
  ).length;
  delete result.value;
  return {
    simultaneousRequests: 3,
    deduplicate,
    browsers,
    ...result,
  };
};

const recovery = async () => {
  let browser;
  cache.flushAll();
  await run(actions.sharh, {
    strategy: 'reuse',
    onBrowser: (value) => {
      browser = value;
    },
  });
  const exited = new Promise((resolve) =>
    browser.process().once('exit', resolve),
  );
  browser.process().kill('SIGKILL');
  await exited;
  return sample('sharh', 'reuse');
};

const recycling = async () => {
  await closeSharedBrowser();
  const rows = [];
  for (let i = 0; i < 11; i++)
    rows.push(await sample('sharh', 'reuse'));
  assert.ok(
    rows.some((row) =>
      row.stages.some((stage) => stage.name === 'recycle'),
    ),
    'Browser was not recycled',
  );
  return rows;
};

module.exports = {
  matrix,
  sample,
  cacheAndPrefetch,
  concurrent,
  recovery,
  recycling,
};

if (require.main === module) {
  process.env.DORAR_FETCH_MODE = 'browser';
  require('../config/config').dorarFetchMode = 'browser';
  (async () => {
    const results = [];
    for (const workflow of [
      'search',
      'sharh',
      'similar',
      'details',
    ]) {
      for (let round = 0; round < 2; round++) {
        const rows = await matrix(workflow, round);
        results.push(...rows);
        console.log(JSON.stringify({ workflow, round, rows }));
      }
    }
    console.log(
      JSON.stringify({
        sharhSearch: await sample('sharhSearch', 'reuse'),
      }),
    );
    console.log(
      JSON.stringify({ cacheAndPrefetch: await cacheAndPrefetch() }),
    );
    for (const deduplicate of [false, true])
      console.log(
        JSON.stringify({ concurrent: await concurrent(deduplicate) }),
      );
    require('node:fs').writeFileSync(
      process.argv[2] || '/tmp/dorar-local-benchmark.json',
      JSON.stringify(results, null, 2),
    );
  })()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(closeSharedBrowser);
}
