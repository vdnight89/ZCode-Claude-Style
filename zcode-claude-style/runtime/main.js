const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let composerSurface;
let composerTop;
let home;
let unmountMascot;
let unmountRipple;
let unmountHud;

if (config.theme) {
  root.dataset.zcCsTheme = 'claude';
  cleanups.push(() => delete root.dataset.zcCsTheme);
}

function visibleAnchor(selector) {
  return [...document.querySelectorAll(selector)].find(node => {
    const bounds = node.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && getComputedStyle(node).visibility === 'visible';
  });
}

function unmountComposer() {
  unmountMascot?.();
  unmountHud?.();
  composerTop?.remove();
  unmountMascot = undefined;
  unmountHud = undefined;
  composerTop = undefined;
}

function syncComposer() {
  const surface = visibleAnchor(selectors.composerSurface);
  if (surface !== composerSurface) {
    unmountComposer();
    composerSurface = surface;
    if (!surface) return;

    composerTop = document.createElement('div');
    composerTop.className = 'zc-cs-composer-top';
    surface.before(composerTop);
    if (config.mascot !== 'off') {
      const mount = config.mascot === 'glm' ? mountGlmMascot : mountMascot;
      unmountMascot = mount(composerTop, reducedMotion);
    }
    const composer = surface.closest(selectors.composer);
    if (config.tokenHud !== false && composer) unmountHud = mountHud(composer, surface, composerTop, selectors);
  }
  // ZCode can insert a task banner before the input after the add-on mounts.
  if (surface && surface.previousElementSibling !== composerTop) surface.before(composerTop);
}

function sync() {
  if (config.mascot !== 'off' || config.tokenHud !== false) {
    syncComposer();
  }
  if (config.homeRipple) {
    const current = visibleAnchor(selectors.home);
    if (current !== home || home && !home.querySelector('.zc-cs-ripple-host')) {
      unmountRipple?.();
      home = current;
      unmountRipple = current && mountRipple(current, reducedMotion);
    }
  }
}

if (config.mascot !== 'off' || config.homeRipple || config.tokenHud !== false) {
  // Mutation callbacks are already batched. Timers can be throttled when ZCode is in the tray.
  const observer = new MutationObserver(records => {
    const elementsChanged = records.some(record => [record.addedNodes, record.removedNodes]
      .some(nodes => Array.prototype.some.call(nodes, node => node.nodeType === Node.ELEMENT_NODE)));
    if (elementsChanged) sync();
  });
  cleanups.push(() => {
    observer.disconnect();
    document.removeEventListener('visibilitychange', sync);
    unmountComposer();
    unmountRipple?.();
  });
  sync();
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', sync);
}
