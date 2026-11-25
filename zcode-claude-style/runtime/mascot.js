function mountMascotControl(footer, mount) {
  const key = 'zcode-claude-style:mascot-visible';
  let enabled = true;
  try {
    enabled = localStorage.getItem(key) !== 'false';
  } catch {
    // The current window can still use the control when storage is unavailable.
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'zc-cs-hud-root zc-cs-hud-button zc-cs-mascot-toggle';
  button.setAttribute('aria-label', '显示吉物');
  button.title = '队列出现时自动隐藏吉物';
  footer.append(button);

  let unmount;
  function render() {
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = enabled ? '吉物 开' : '吉物 关';
    if (enabled) unmount = mount();
    else {
      unmount?.();
      unmount = undefined;
    }
  }
  const toggle = () => {
    enabled = !enabled;
    try {
      localStorage.setItem(key, String(enabled));
    } catch {
      // Keep the selected state for this control even without persistent storage.
    }
    render();
  };

  button.addEventListener('click', toggle);
  render();
  return () => {
    button.removeEventListener('click', toggle);
    unmount?.();
    button.remove();
  };
}

function mountMascot(anchor, reducedMotion) {
  const { CRAB_FRAME_MS, CRAB_GUTTER, CRAB_SHEETS, CRAB_SHEET_URLS } = crabAssets;
  const view = document.createElement('span');
  const sprite = document.createElement('span');
  const strip = document.createElement('span');
  const button = document.createElement('button');
  view.className = 'zc-cs-mascot zc-cs-crab';
  view.dataset.zcCsMascot = 'crab';
  sprite.className = 'zc-cs-crab-sprite';
  sprite.setAttribute('aria-hidden', 'true');
  strip.className = 'zc-cs-crab-strip';
  button.className = 'zc-cs-crab-hit';
  button.type = 'button';
  button.setAttribute('aria-label', 'Clawd');
  sprite.append(strip);
  view.append(sprite, button);
  anchor.append(view);

  const stage = mascotCore.freshStage(Date.now());
  let animation;
  let timer;
  let disposed = false;
  const duration = key => CRAB_SHEETS[key].frames * CRAB_FRAME_MS;
  const offset = (sheet, frame) => mascotCore.frameOffset(sheet, frame, CRAB_GUTTER);

  function show(next, now) {
    animation?.cancel();
    animation = undefined;
    const sheet = CRAB_SHEETS[next.key];
    const urls = CRAB_SHEET_URLS[next.key];
    const [x, y, width, height] = sheet.box;
    const [cellWidth, cellHeight] = mascotCore.cellSize(sheet, CRAB_GUTTER);
    const columns = sheet.columns || 8;
    const spriteStyles = { x, y, width, height, 'strip-width': cellWidth * columns,
      'strip-height': cellHeight * Math.ceil(sheet.frames / columns) };
    for (const [name, value] of Object.entries(spriteStyles)) {
      view.style.setProperty('--zc-cs-crab-' + name, value * 2 + 'px');
    }
    view.style.setProperty('--zc-cs-crab-sheet', 'url("' + urls.body + '")');
    view.style.setProperty('--zc-cs-crab-mask', 'url("' + urls.ink + '")');
    view.dataset.zcCsAnimation = next.key;

    stage.current = { ...next, start: now, done: false };
    if (stage.reaction?.key === next.key) stage.reaction.fresh = false;
    strip.style.transform = offset(sheet, sheet.still);
    if (reducedMotion.matches || document.hidden) return;

    const frames = Array.from({ length: sheet.frames }, (_, frame) => ({
      offset: frame / sheet.frames, transform: offset(sheet, frame), easing: 'steps(1)',
    }));
    frames.push({ offset: 1, transform: offset(sheet, next.mode === 'loop' ? 0 : sheet.frames - 1) });
    animation = strip.animate(frames, {
      duration: duration(next.key), iterations: next.mode === 'loop' ? Infinity : 1, fill: 'forwards',
    });
  }

  function tick(force = false) {
    clearTimeout(timer);
    if (disposed) return;
    const now = Date.now();
    const current = stage.current;
    if (current?.mode === 'once' && !current.done && now >= current.start + duration(current.key)) {
      current.done = true;
      mascotCore.finishStage(stage, current.key, now, Math.random);
    }
    const next = mascotCore.decideStage(stage, now, stage.level, {
      extras: mascotCore.CRAB_EXTRAS,
      extrasAllowed: !reducedMotion.matches && !document.hidden,
      random: Math.random,
    });
    if (force || stage.reaction?.fresh || current?.key !== next.key) show(next, now);
    if (document.hidden) return;
    const decision = mascotCore.nextDecisionAt(stage, now, false, duration);
    if (Number.isFinite(decision)) timer = setTimeout(tick, Math.max(1, decision - now));
  }

  const onMotion = () => tick(true);
  const onClick = event => {
    const now = Date.now();
    stage.quietSince = now;
    stage.asleep = false;
    stage.clicks = stage.clicks.filter(time => now - time < 450);
    stage.clicks.push(now);
    const box = button.getBoundingClientRect();
    const left = !!event.detail && event.clientX < box.left + box.width / 2;
    const key = stage.clicks.length >= 4 ? 'tickle' : (left ? 'poke-left' : 'poke-right');
    if (key === 'tickle') stage.clicks = [];
    stage.reaction = { key, mode: 'once', fresh: true };
    tick();
  };
  button.addEventListener('click', onClick);
  reducedMotion.addEventListener('change', onMotion);
  document.addEventListener('visibilitychange', onMotion);
  tick();
  return () => {
    disposed = true;
    clearTimeout(timer);
    animation?.cancel();
    button.removeEventListener('click', onClick);
    reducedMotion.removeEventListener('change', onMotion);
    document.removeEventListener('visibilitychange', onMotion);
    view.remove();
  };
}

function mountGlmMascot(anchor, reducedMotion) {
  const view = document.createElement('span');
  const button = document.createElement('button');
  const image = document.createElement('img');
  view.className = 'zc-cs-mascot zc-cs-glm';
  view.dataset.zcCsMascot = 'glm';
  view.dataset.zcCsAnimation = 'idle';
  button.className = 'zc-cs-glm-hit';
  button.type = 'button';
  button.setAttribute('aria-label', 'GLM 娘');
  image.alt = '';
  image.draggable = false;
  image.src = glmMascotImage;
  button.append(image);
  view.append(button);
  anchor.append(view);

  let reaction;
  let timer;
  const onClick = () => {
    clearTimeout(timer);
    reaction?.cancel();
    view.dataset.zcCsAnimation = 'bounce';
    if (!reducedMotion.matches && !document.hidden) {
      reaction = image.animate([
        { transform: 'translateY(0) scale(1)' },
        { transform: 'translateY(2px) scale(1.04, .94)', offset: .18 },
        { transform: 'translateY(-9px) rotate(-5deg)', offset: .5 },
        { transform: 'translateY(0) scale(1)' },
      ], { duration: 430, easing: 'ease-in-out' });
    }
    timer = setTimeout(() => { view.dataset.zcCsAnimation = 'idle'; }, 440);
  };
  const onMotion = () => {
    if (reducedMotion.matches || document.hidden) reaction?.cancel();
  };
  button.addEventListener('click', onClick);
  reducedMotion.addEventListener('change', onMotion);
  document.addEventListener('visibilitychange', onMotion);
  return () => {
    clearTimeout(timer);
    reaction?.cancel();
    button.removeEventListener('click', onClick);
    reducedMotion.removeEventListener('change', onMotion);
    document.removeEventListener('visibilitychange', onMotion);
    view.remove();
  };
}
