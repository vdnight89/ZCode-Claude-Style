'use strict';

const assert = require('node:assert/strict');
const { CdpSession, discover } = require('./cdp');

function readLayout() {
  const top = document.querySelector('.zc-cs-hud-top:not([hidden])');
  const compact = top?.querySelector('[data-zc-hud-action="compact"]');
  const surface = document.querySelector('.chat-composer-input-surface:has(> .zc-cs-hud-rim)');
  if (!compact || !surface) return null;

  const mascot = surface.closest('[data-testid="v4-composer"]').querySelector('.zc-cs-mascot');
  const strip = top.getBoundingClientRect();
  const action = compact.getBoundingClientRect();
  const atAction = document.elementFromPoint(action.left + action.width / 2, action.top + action.height / 2);
  return {
    width: innerWidth, dpr: devicePixelRatio,
    stripGap: surface.getBoundingClientRect().top - strip.bottom,
    mascotGap: mascot ? strip.top - mascot.getBoundingClientRect().bottom : null,
    actionReachable: compact.contains(atAction),
  };
}

async function run() {
  const endpoint = await discover();
  if (!endpoint?.pages.length) throw new Error('找不到带调试端口的 ZCode 主窗口');
  const session = await CdpSession.connect(endpoint.pages[0].ws);
  const evaluate = callback => session.evaluate('(' + callback.toString() + ')()');

  async function check(label) {
    const state = await evaluate(readLayout);
    assert.ok(state && state.mascotGap != null, '请打开已显示用量条和吉物的会话');
    console.log(JSON.stringify({ label, ...state }));
    assert.ok(state.stripGap >= 0 && state.stripGap <= 8, '用量条应紧贴输入框上方');
    assert.ok(state.mascotGap >= 0, '吉物不能盖住用量条');
    assert.ok(state.actionReachable, '/compact 应可点击');
  }

  let metricsChanged = false;
  try {
    await check('current-window');
    await evaluate(() => {
      const surface = document.querySelector('.chat-composer-input-surface:has(> .zc-cs-hud-rim)');
      const banner = document.createElement('div');
      banner.dataset.zcCsLayoutSmoke = '';
      banner.style.height = '48px';
      surface.before(banner);
    });
    await check('late-native-sibling');
    for (const [width, deviceScaleFactor] of [[1024, 1], [850, 1.5], [768, 2]]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor, mobile: false });
      metricsChanged = true;
      await check('resized-window');
    }
  } finally {
    try {
      if (metricsChanged) await session.send('Emulation.clearDeviceMetricsOverride');
      await evaluate(() => document.querySelector('[data-zc-cs-layout-smoke]')?.remove());
    } finally {
      session.close();
    }
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
