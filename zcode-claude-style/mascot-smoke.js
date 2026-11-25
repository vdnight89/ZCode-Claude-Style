'use strict';

const assert = require('node:assert/strict');
const { CdpSession, discover } = require('./cdp');

async function run() {
  const endpoint = await discover();
  if (!endpoint?.pages.length) throw new Error('找不到带调试端口的 ZCode 主窗口');
  const session = await CdpSession.connect(endpoint.pages[0].ws);
  const evaluate = callback => session.evaluate('(' + callback.toString() + ')()');

  try {
    const queue = await evaluate(() => {
      const anchor = document.querySelector('.zc-cs-composer-top');
      const composer = anchor?.closest('[data-testid="v4-composer"]');
      if (!composer) return null;

      let queue = composer.querySelector('[data-testid="v4-queue"]');
      const native = Boolean(queue);
      if (!queue) {
        queue = document.createElement('div');
        queue.dataset.testid = 'v4-queue';
        queue.dataset.zcCsMascotSmoke = '';
        queue.style.cssText = 'display:flex;justify-content:flex-end;align-items:flex-end;height:64px;padding:4px 8px';
        for (const action of ['edit', 'delete']) {
          const item = document.createElement('button');
          item.type = 'button';
          item.dataset.testid = 'v4-queue-item-' + action + '-fixture';
          item.style.width = '26px';
          item.textContent = action === 'edit' ? '编' : '删';
          queue.append(item);
        }
        anchor.before(queue);
      }

      const reachable = node => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return width > 0 && height > 0 && node.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      };
      const available = prefix => {
        const buttons = [...queue.querySelectorAll('[data-testid^="' + prefix + '"]')];
        return { count: buttons.length, reachable: buttons.every(reachable) };
      };
      const mascot = anchor.querySelector('.zc-cs-mascot');
      return { native, edit: available('v4-queue-item-edit-'), remove: available('v4-queue-item-delete-'),
        resume: available('v4-queue-resume'), mascotHidden: !mascot || getComputedStyle(mascot).visibility === 'hidden' };
    });
    assert.ok(queue?.edit.count && queue.remove.count, '打开一个带输入框的会话后再验证');
    console.log(JSON.stringify(queue));
    assert.ok(queue.edit.reachable && queue.remove.reachable && queue.resume.reachable, '队列控件必须可点击');
    assert.ok(queue.mascotHidden, '有消息队列时应自动隐藏吉物');

    const toggle = await evaluate(() => {
      document.querySelector('[data-zc-cs-mascot-smoke]')?.remove();
      const button = document.querySelector('.zc-cs-mascot-toggle');
      if (!button) return null;
      const composer = button.closest('[data-testid="v4-composer"]');
      const key = 'zcode-claude-style:mascot-visible';
      const saved = localStorage.getItem(key);
      const first = button.getAttribute('aria-pressed');
      const { x, y, width, height } = button.getBoundingClientRect();
      const reachable = button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      const snapshot = () => ({ pressed: button.getAttribute('aria-pressed'),
        mounted: Boolean(composer.querySelector('.zc-cs-mascot')), stored: localStorage.getItem(key) });
      try {
        button.click();
        const changed = snapshot();
        button.click();
        return { first, reachable, changed, restored: snapshot() };
      } finally {
        if (button.getAttribute('aria-pressed') !== first) button.click();
        if (saved === null) localStorage.removeItem(key);
        else localStorage.setItem(key, saved);
      }
    });
    assert.ok(toggle?.reachable, '吉物开关必须可点击');
    const shown = toggle.first === 'true';
    assert.deepEqual(toggle.changed, { pressed: String(!shown), mounted: !shown, stored: String(!shown) });
    assert.deepEqual(toggle.restored, { pressed: String(shown), mounted: shown, stored: String(shown) });
    console.log(JSON.stringify(toggle));
  } finally {
    try {
      await evaluate(() => document.querySelector('[data-zc-cs-mascot-smoke]')?.remove());
    } finally {
      session.close();
    }
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
