function mountRipple(home, reducedMotion) {
  const { RIPPLE, createGlyphField, createWaveField, parseCssColorToRgb } = rippleCore;
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.className = 'zc-cs-ripple-host';
  host.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  home.dataset.zcCsHome = '';
  home.prepend(host);

  let glyphs;
  let waves;
  let frame;
  let timer;
  let last = performance.now();
  let width = 0;
  let height = 0;
  let ratio = 0;
  let disposed = false;

  function resize() {
    const nextWidth = host.clientWidth;
    const nextHeight = host.clientHeight;
    const nextRatio = Math.min(devicePixelRatio || 1, 2);
    if (nextWidth === width && nextHeight === height && nextRatio === ratio) return;
    width = nextWidth;
    height = nextHeight;
    ratio = nextRatio;
    glyphs?.dispose();
    glyphs = undefined;
    waves = undefined;
    if (width <= 0 || height <= 0) return;
    const columns = Math.ceil(width / RIPPLE.cellWidth);
    const rows = Math.ceil(height / RIPPLE.cellHeight);
    canvas.width = Math.round(columns * RIPPLE.cellWidth * ratio);
    canvas.height = Math.round(rows * RIPPLE.cellHeight * ratio);
    canvas.style.width = columns * RIPPLE.cellWidth + 'px';
    canvas.style.height = rows * RIPPLE.cellHeight + 'px';
    waves = createWaveField(columns, rows);
    glyphs = createGlyphField(canvas, columns, rows, waves);
  }

  function schedule() {
    if (disposed || document.hidden || frame) return;
    clearTimeout(timer);
    frame = requestAnimationFrame(draw);
  }

  function draw(now) {
    frame = undefined;
    if (disposed || !glyphs || document.hidden) return;
    const still = reducedMotion.matches;
    waves.advance(still ? 0 : Math.min(0.05, (now - last) / 1000));
    last = now;
    if (glyphs.needsDraw(now, still)) {
      const css = getComputedStyle(host);
      glyphs.draw(now, {
        fontFamily: 'Consolas, "Courier New", monospace',
        ink: parseCssColorToRgb(css.getPropertyValue('--zc-cs-ripple-ink')) || [156, 147, 149],
        wave: parseCssColorToRgb(css.getPropertyValue('--zc-cs-ripple-wave')) || [217, 119, 87],
        dark: document.documentElement.classList.contains('dark'),
      }, still);
    }
    if (still) return;
    if (glyphs.busy()) schedule();
    else timer = setTimeout(schedule, 1000 / RIPPLE.changeRate);
  }

  function visibility() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = undefined;
      clearTimeout(timer);
      return;
    }
    last = performance.now();
    resize();
    glyphs?.invalidate();
    schedule();
  }

  function press(event) {
    if (event.button !== 0 || !waves || reducedMotion.matches) return;
    if (event.target.closest('button, a, input, textarea, [contenteditable], [role="button"]')) return;
    const rect = canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right ||
        event.clientY < rect.top || event.clientY >= rect.bottom) return;
    last = performance.now();
    waves.disturb(Math.floor((event.clientX - rect.left) / RIPPLE.cellWidth),
      Math.floor((event.clientY - rect.top) / RIPPLE.cellHeight));
    schedule();
  }

  const observer = new ResizeObserver(() => {
    resize();
    schedule();
  });
  observer.observe(host);
  const theme = new MutationObserver(visibility);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('pointerdown', press, { passive: true });
  document.addEventListener('visibilitychange', visibility);
  reducedMotion.addEventListener('change', visibility);
  resize();
  visibility();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    observer.disconnect();
    theme.disconnect();
    document.removeEventListener('pointerdown', press);
    document.removeEventListener('visibilitychange', visibility);
    reducedMotion.removeEventListener('change', visibility);
    glyphs?.dispose();
    delete home.dataset.zcCsHome;
    host.remove();
  };
}
