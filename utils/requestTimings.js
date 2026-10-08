const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { readFileSync } = require('node:fs');

const context = new AsyncLocalStorage();
const current = () => context.getStore();
const middleware = (req, res, next) =>
  context.run({ stages: [], started: performance.now() }, next);
const header = () => {
  const trace = current();
  if (!trace) return undefined;
  return [
    ...trace.stages.map(
      (stage) => `${stage.name};dur=${stage.ms.toFixed(2)}`,
    ),
    `server;dur=${(performance.now() - trace.started).toFixed(2)}`,
  ].join(', ');
};

const measure = async (name, action) => {
  const trace = current();
  if (!trace) return action();
  const started = performance.now();
  try {
    return await action();
  } finally {
    trace.stages.push({ name, ms: performance.now() - started });
  }
};

const browserResources = (browser) => {
  try {
    const pid = browser.process().pid;
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      rssMB: Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0) / 1024,
      cpuMs: (Number(fields[11]) + Number(fields[12])) * 10,
    };
  } catch {
    return { rssMB: 0, cpuMs: 0 };
  }
};

const run = async (action, options = {}) => {
  const trace = { ...options, stages: [], background: [] };
  return context.run(trace, async () => {
    const started = performance.now();
    const cpu = process.cpuUsage();
    const value = await action();
    const responseReadyMs = performance.now() - started;
    await Promise.allSettled(trace.background);
    const used = process.cpuUsage(cpu);
    return {
      value,
      responseReadyMs,
      workCompleteMs: performance.now() - started,
      stages: trace.stages,
      nodeCpuMs: (used.user + used.system) / 1000,
      nodeRssMB: process.memoryUsage().rss / 1024 / 1024,
      chromeRssMB: trace.chromeRssMB || 0,
      chromeCpuMs: trace.chromeCpuMs || 0,
    };
  });
};

module.exports = {
  current,
  measure,
  browserResources,
  run,
  middleware,
  header,
};
