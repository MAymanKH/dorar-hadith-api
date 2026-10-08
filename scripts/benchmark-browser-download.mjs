import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(process.cwd() + '/package.json');
const p = await import(require.resolve('puppeteer-core'));
const { default: c } = await import(
  require.resolve('@sparticuz/chromium')
);
const b = await p.launch({
  executablePath: await c.executablePath(),
  headless: 'shell',
  args: [...c.args, '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
try {
  const page = await b.newPage();
  await page.setUserAgent(
    (await b.userAgent()).replace('HeadlessChrome', 'Chrome'),
  );
  const session = await page.createCDPSession();
  const { frameTree } = await session.send('Page.getFrameTree');
  const start = performance.now();
  const { resource } = await session.send(
    'Network.loadNetworkResource',
    {
      frameId: frameTree.frame.id,
      url: 'https://www.dorar.net/hadith/search?q=%D8%A7%D9%84%D9%85%D8%A7%D9%84',
      options: { disableCache: true, includeCredentials: false },
    },
  );
  const headersMs = performance.now() - start;
  let body = '';
  if (resource.stream) {
    try {
      for (;;) {
        const x = await session.send('IO.read', {
          handle: resource.stream,
          size: 1048576,
        });
        body += x.base64Encoded
          ? Buffer.from(x.data, 'base64').toString('utf8')
          : x.data;
        if (x.eof) break;
      }
    } finally {
      await session.send('IO.close', { handle: resource.stream });
    }
  }
  const doc = require('linkedom').parseHTML(body).document;
  console.log(
    JSON.stringify({
      status: resource.httpStatusCode,
      success: resource.success,
      headersMs: Math.round(headersMs),
      totalMs: Math.round(performance.now() - start),
      count: doc.querySelectorAll('#home .border-bottom').length,
      error: resource.netErrorName,
    }),
  );
} finally {
  await b.close();
}
