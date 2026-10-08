const { execFileSync } = require('node:child_process');
const {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

const base = process.argv[2];
assert.ok(
  base?.startsWith('https://'),
  'Usage: node scripts/benchmark-http.js <url> [output.json] [--preview]',
);
const query = (t) =>
  new URLSearchParams({
    value: 'المال',
    page: 1,
    st: 'a',
    t,
    'd[]': 0,
    'm[]': 0,
    's[]': 0,
  });
const cases = [
  ['first explanation', '/v1/site/sharh/10301'],
  ['explanation CDN', '/v1/site/sharh/10301'],
  ['search fresh', `/v1/site/hadith/search?${query('*')}`],
  ['search CDN', `/v1/site/hadith/search?${query('*')}`],
  ['similar fresh', '/v1/site/hadith/similar/CxhuYTbO'],
  ['details fresh', '/v1/site/hadith/CxhuYTbO'],
  ['sharh search fresh', `/v1/site/hadith/search?${query('3')}`],
  ['sharh search CDN', `/v1/site/hadith/search?${query('3')}`],
  [
    'search HTML',
    '/v1/site/hadith/search?value=%D8%A7%D9%84%D9%85%D8%A7%D9%84&removehtml=false',
  ],
];
const results = [];
const directory = mkdtempSync(join(tmpdir(), 'dorar-http-'));
try {
  for (const [name, path] of cases) {
    const headersPath = join(directory, 'headers');
    const bodyPath = join(directory, 'body');
    const args = [
      base + path,
      '--silent',
      '--show-error',
      '--max-time',
      '60',
      '-D',
      headersPath,
      '-o',
      bodyPath,
      '-w',
      '{"status":%{http_code},"dns":%{time_namelookup},"connect":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"total":%{time_total},"bytes":%{size_download}}',
    ];
    const preview = process.argv.includes('--preview');
    const output = execFileSync(
      preview ? 'npm' : 'curl',
      preview
        ? [
            'exec',
            '--yes',
            '--package=vercel',
            '--',
            'vercel',
            'curl',
            args[0],
            '--',
            ...args.slice(1),
          ]
        : args,
      {
        encoding: 'utf8',
        timeout: 90000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const wire = JSON.parse(output);
    const body = JSON.parse(readFileSync(bodyPath));
    assert.equal(wire.status, 200, body.message);
    const first = Array.isArray(body.data) ? body.data[0] : body.data;
    assert.ok(
      first.hadith && first.rawi && first.hadithId,
      'Incomplete hadith',
    );
    if (name.includes('explanation') || name.includes('sharh'))
      assert.ok(first.sharhMetadata?.sharh);
    if (name === 'search HTML') assert.ok(first.hadith.includes('<'));
    const headers = readFileSync(headersPath, 'utf8');
    const cdn = headers
      .match(/^x-vercel-cache:\s*(.*)$/im)?.[1]
      ?.trim();
    const stages =
      cdn === 'HIT'
        ? []
        : (headers.match(/^server-timing:\s*(.*)$/im)?.[1] || '')
            .trim()
            .split(',')
            .map((value) => value.trim().split(';dur='))
            .filter((value) => value.length === 2)
            .map(([name, ms]) => ({ name, ms: Number(ms) }));
    const row = {
      name,
      wire,
      cdn,
      stages,
      nodeCached: body.metadata?.isCached,
      count: Array.isArray(body.data) ? body.data.length : 1,
    };
    results.push(row);
    writeFileSync(
      process.argv[3] || '/tmp/dorar-http-benchmark.json',
      JSON.stringify({ base, results }, null, 2),
    );
    console.log(
      JSON.stringify({
        name,
        status: wire.status,
        seconds: wire.total,
        cdn,
        count: row.count,
        serverMs: stages.find((s) => s.name === 'server')?.ms,
        hydrateMs: stages.find((s) => s.name === 'hydrate')?.ms,
      }),
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
