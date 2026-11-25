'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { CdpSession, discover } = require('./cdp');
const selectors = require('./selectors.json');

const exec = promisify(execFile);
const logs = path.join(__dirname, '..', 'logs');

function readPage(selectors) {
  const query = value => document.querySelector(value);
  const style = document.getElementById('zcode-claude-style-css');
  const crab = query('.zc-cs-mascot');
  const button = crab?.querySelector('button');
  const canvas = query('.zc-cs-ripple-host canvas');
  const bounds = button?.getBoundingClientRect();
  const viewport = query(selectors.timeline);
  const x = bounds ? Math.round(bounds.x + bounds.width / 2) : 0;
  const y = bounds ? Math.round(bounds.y + bounds.height / 2) : 0;
  const draft = query(selectors.editor)?.textContent.trim().length ?? null;
  const anchorCounts = Object.fromEntries(Object.entries(selectors)
    .map(([key, selector]) => [key, document.querySelectorAll(selector).length]));
  return {
    visible: !document.hidden,
    style: style?.textContent.length || 0,
    palette: getComputedStyle(document.documentElement).getPropertyValue('--zc-cs-palette').trim(),
    anchorCounts,
    rows: Number(viewport?.getAttribute('data-total-row-count')) || 0,
    groups: viewport?.querySelectorAll('[data-consecutive-summary-group]').length || 0,
    crab: crab?.dataset.zcCsAnimation || null,
    animations: crab?.getAnimations({ subtree: true }).length || 0,
    canvas: canvas ? [canvas.width, canvas.height] : null,
    draft,
    target: bounds ? { x, y, hit: document.elementFromPoint(x, y) === button } : null,
    flags: document.querySelectorAll('[data-zc-cs-home], [data-zc-cs-theme]').length,
    runtime: typeof globalThis.__zcClaudeStyle,
    cleanup: typeof globalThis.__zcCsCleanups,
  };
}

function evaluate(session, fn, ...values) {
  return session.evaluate('(' + fn.toString() + ')(' + values.map(value => JSON.stringify(value)).join(',') + ')');
}

async function until(read, predicate, timeout = 7000) {
  const start = performance.now();
  let result;
  do {
    result = await read();
    if (predicate(result)) return result;
    await delay(65);
  } while (performance.now() - start < timeout);
  throw new Error('未达到预期页面状态 ' + JSON.stringify(result));
}

function onHome() {
  document.querySelector('[data-testid="task-new-button"]')?.click();
}
function openSample(index) {
  document.querySelectorAll('li[data-testid^="task-item-"]')[index]?.click();
}

async function run() {
  const navigate = process.argv.includes('--navigate');
  const capture = process.argv.includes('--capture');
  const existing = process.argv.includes('--existing');
  const leave = existing || process.argv.includes('--leave');
  const endpoint = await discover();
  if (!endpoint?.pages.length) throw new Error('找不到带调试端口的 ZCode 主窗口');
  const session = await CdpSession.connect(endpoint.pages[0].ws);
  const report = { timestamp: new Date().toISOString(), hostPid: endpoint.pid, errors: [] };
  const read = () => evaluate(session, readPage, selectors);
  let changedPage = false;
  let injected = false;
  try {
    await session.send('Runtime.enable');
    session.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const message = exceptionDetails.exception?.description || exceptionDetails.text;
      if (/zc-cs|zcode-claude-style|mountRipple|mountMascot/.test(message)) report.errors.push(message);
    });
    session.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error' && args[0]?.value?.includes?.('[zcode-claude-style]')) report.errors.push(args[0].value);
    });

    const initial = await read();
    assert.equal(initial.anchorCounts.home, 1, '请先切换到 ZCode 首页');
    assert.equal(initial.draft, 0, '请先保存首页输入框中的草稿');
    if (!existing) {
      await exec(process.execPath, [path.join(__dirname, 'inject.js')]);
      injected = true;
    }
    const home = await until(read, state => state.crab && state.canvas && state.style);
    report.home = home;
    assert.equal(home.palette, 'claude');
    assert.ok(home.target?.hit);
    assert.ok(home.canvas[0] > 300 && home.canvas[1] > 150);
    if (home.visible) assert.ok(home.animations >= 1);

    if (capture) {
      assert.ok(home.visible, '请将 ZCode 主窗口置于前台后截取画面');
      const clip = await evaluate(session, () => {
        const box = document.querySelector('[data-testid="chat-empty"]').getBoundingClientRect();
        const left = Math.max(0, Math.round(box.left - 54));
        const top = Math.max(0, Math.round(box.top - 216));
        return { x: left, y: top, width: Math.min(innerWidth - left, Math.round(box.width + 108)),
          height: Math.min(innerHeight - top, 600), scale: 1 };
      });
      const screenshot = await session.send('Page.captureScreenshot', {
        format: 'png', clip, captureBeyondViewport: false,
      });
      await fs.writeFile(path.join(logs, 'zcode-home-after.png'), Buffer.from(screenshot.data, 'base64'));
    }

    if (home.visible) {
      const { x, y } = home.target;
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      report.clickInput = 'mouse';
    } else {
      await evaluate(session, () => document.querySelector('.zc-cs-mascot button').click());
      report.clickInput = 'DOM';
    }
    report.clicked = (await until(read, state => state.crab === 'bounce' || state.crab?.startsWith('poke-'))).crab;
    if (navigate) {
      report.conversations = [];
      // Read existing sessions by position. No message, account or session ID is saved.
      for (const index of [0, 1, 6, 8, 10]) {
        await evaluate(session, openSample, index);
        changedPage = true;
        try {
          const conversation = await until(read, state => !state.anchorCounts.home &&
            state.anchorCounts.turn > 0 && !!state.crab && !state.canvas, 4000);
          report.conversations.push({ index, ...conversation });
        } catch (error) {
          if (!error.message.startsWith('未达到预期页面状态')) throw error;
        }
        const start = performance.now();
        await evaluate(session, onHome);
        report.returnedHome = await until(read, state => state.anchorCounts.home && state.canvas && state.crab);
        report.returnedHomeMs = Math.round(performance.now() - start);
        changedPage = false;
        if (report.conversations.some(item => item.groups > 0) &&
            report.conversations.some(item => item.rows < 100)) break;
      }
      assert.ok(report.conversations.some(item => item.groups > 0), '找不到包含工具组的会话');
      assert.ok(report.conversations.some(item => item.rows > 0 && item.rows < 100), '找不到短会话样本');
    }

    if (!leave) {
      await exec(process.execPath, [path.join(__dirname, 'remove.js')]);
      injected = false;
      report.removed = await read();
      const removed = report.removed;
      assert.ok(!removed.style && !removed.canvas && !removed.crab && !removed.flags);
      assert.equal(removed.runtime, 'undefined');
      assert.equal(removed.cleanup, 'undefined');
    }
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } finally {
    if (changedPage) await evaluate(session, onHome).catch(() => {});
    if (injected && (!leave || !report.ok)) {
      await exec(process.execPath, [path.join(__dirname, 'remove.js')]).catch(error => console.error(error.message));
    }
    await fs.mkdir(logs, { recursive: true });
    const filename = 'zcode-features' + (capture ? '-visible' : existing ? '-launcher' : '') + '.json';
    await fs.writeFile(path.join(logs, filename), JSON.stringify(report, null, 2) + '\n');
    session.close();
  }
  console.log(JSON.stringify({
    ok: report.ok, visible: report.home.visible, click: report.clicked, clickInput: report.clickInput,
    returnedHomeMs: report.returnedHomeMs, rows: report.conversations?.map(item => item.rows), errors: report.errors.length,
  }));
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
