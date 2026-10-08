const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');

const deployment = process.argv[2];
assert.ok(
  deployment?.startsWith('https://'),
  'Usage: node scripts/benchmark-vercel.js <preview-url> [output.json]',
);
const results = [];
const jobs = ['search', 'sharh', 'similar', 'details'].flatMap(
  (workflow) => [0, 1].map((round) => ({ workflow, round })),
);
jobs.push(
  { test: 'sample', workflow: 'sharhSearch' },
  { test: 'recovery' },
  { test: 'recycling' },
  { test: 'cache' },
  { test: 'concurrent', deduplicate: false },
  { test: 'concurrent', deduplicate: true },
);

for (const job of jobs) {
  const url = `${deployment}/__benchmark?${new URLSearchParams(job)}`;
  const output = execFileSync(
    'npm',
    [
      'exec',
      '--yes',
      '--package=vercel',
      '--',
      'vercel',
      'curl',
      url,
      '--',
      '--silent',
      '--show-error',
      '--max-time',
      '60',
    ],
    {
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const response = JSON.parse(output);
  assert.ok(response.result, response.message || 'Benchmark failed');
  results.push({ job, ...response });
  writeFileSync(
    process.argv[3] || '/tmp/dorar-vercel-benchmark.json',
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify({
      job,
      region: response.region,
      samples: Array.isArray(response.result)
        ? response.result.length
        : 1,
    }),
  );
}
