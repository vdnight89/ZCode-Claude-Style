'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { CdpSession, discover, writeFileAtomic } = require('./cdp');

const minute = 60000;
const duration = Number(process.argv[2] || 60) * minute;
const interval = Math.min(5 * minute, duration / 2);
const reportName = duration === 60 * minute ? 'zcode-soak.json'
  : 'zcode-soak-' + duration / minute + 'min.json';
const reportPath = path.join(__dirname, '..', 'logs', reportName);

function landmarks() {
  return {
    css: document.querySelectorAll('#zcode-claude-style-css').length,
    crab: document.querySelectorAll('.zc-cs-mascot').length,
    wave: document.querySelectorAll('.zc-cs-ripple-host canvas').length,
    home: !!document.querySelector('[data-testid="chat-empty"]'),
    visible: !document.hidden,
  };
}

async function sample(session, startedAt) {
  await session.send('HeapProfiler.collectGarbage');
  const [heap, dom, page] = await Promise.all([
    session.send('Runtime.getHeapUsage'),
    session.send('Memory.getDOMCounters'),
    session.evaluate('(' + landmarks.toString() + ')()'),
  ]);
  assert.equal(page.css, 1);
  assert.ok(page.crab <= 1);
  assert.equal(page.wave, page.home ? 1 : 0);
  return {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    usedBytes: heap.usedSize,
    ...dom,
    ...page,
  };
}

async function run() {
  if (!Number.isFinite(duration) || duration < 15000) throw new Error('请输入至少 0.25 分钟');
  const endpoint = await discover();
  if (!endpoint?.pages.length) throw new Error('找不到带调试端口的 ZCode 主窗口');
  const page = endpoint.pages[0];
  let session;
  const startedAt = Date.now();
  const report = {
    status: 'running',
    expectedMinutes: duration / minute,
    hostPid: endpoint.pid,
    startedAt: new Date(startedAt).toISOString(),
    errors: [],
    reconnects: 0,
    samples: [],
  };
  const save = () => writeFileAtomic(reportPath, JSON.stringify(report, null, 2) + '\n');

  async function connect() {
    const current = await discover();
    const target = current?.pages.find(item => item.id === page.id);
    if (current?.identity !== endpoint.identity || current.pid !== endpoint.pid || !target) {
      throw new Error('ZCode 主窗口已退出或切换，连续观察结束');
    }
    const connection = await CdpSession.connect(target.ws);
    session = connection;
    await connection.send('Runtime.enable');
    connection.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const message = exceptionDetails.exception?.description || exceptionDetails.text;
      if (/zc-cs|zcode-claude-style|mountRipple|mountMascot/.test(message)) report.errors.push(message);
    });
    connection.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error' && args[0]?.value?.includes?.('[zcode-claude-style]')) report.errors.push(args[0].value);
    });
  }

  try {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await connect();
    const finish = startedAt + duration;
    for (let next = startedAt; ; next = Math.min(next + interval, finish)) {
      await delay(Math.max(0, next - Date.now()));
      let result;
      try {
        result = await sample(session, startedAt);
      } catch (error) {
        if (!session.closed) throw error;
        await connect();
        report.reconnects++;
        result = await sample(session, startedAt);
      }
      report.samples.push(result);
      await save();
      console.log(JSON.stringify(result));
      if (next === finish) break;
    }

    assert.deepEqual(report.errors, []);
    const first = report.samples[0];
    const last = report.samples.at(-1);
    const comparable = report.samples.every(point => point.home === first.home && point.visible === first.visible);
    report.summary = {
      comparable,
      heapDeltaBytes: last.usedBytes - first.usedBytes,
      nodeDelta: last.nodes - first.nodes,
      listenerDelta: last.jsEventListeners - first.jsEventListeners,
      sameLandingState: first.home && last.home && first.crab === last.crab && first.wave === last.wave,
    };
    report.status = 'completed';
    await save();
  } catch (error) {
    report.status = 'interrupted';
    report.failure = error.message;
    await save();
    throw error;
  } finally {
    session?.close();
  }
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
