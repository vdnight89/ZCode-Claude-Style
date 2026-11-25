(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.__agCsMascotCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const MIN_SHOW_MS = 1000;
  const SLEEP_AFTER_MS = 60000;
  const EXTRA_MIN_MS = 20000;
  const EXTRA_SPAN_MS = 20000;
  const REACTION_PRIORITY = 10;
  const CRAB_EXTRAS = ['idle-look', 'idle-wave', 'idle-laptop'];

  const MOMENTS = {
    error: { state: 'error', animation: 'error', priority: 8, holdMs: 4800 },
    attention: { state: 'attention', animation: 'happy', priority: 5, holdMs: 5200 },
  };

  function freshStage(now) {
    return {
      sessionId: null,
      level: { state: 'idle', animation: 'idle', priority: 1 },
      moment: null,
      queued: null,
      reaction: null,
      extra: null,
      waking: false,
      asleep: false,
      quietSince: now,
      nextExtraAt: 0,
      current: null,
      animation: null,
      timer: null,
      clicks: [],
      press: null,
    };
  }

  function startMoment(stage, name, now) {
    const next = MOMENTS[name];
    stage.moment = { state: next.state, animation: next.animation, priority: next.priority, until: now + next.holdMs };
  }

  function takeMoment(stage, name, now) {
    if (!MOMENTS[name]) return false;
    if (stage.moment !== null && now < stage.moment.until && stage.moment.priority > MOMENTS[name].priority) {
      stage.queued = name;
      return false;
    }
    startMoment(stage, name, now);
    return true;
  }

  function levelFromActiveInfo(info) {
    if (!info) return { state: 'idle', animation: 'idle', priority: 1 };
    if (info.hasError) return { state: 'error', animation: 'error', priority: 8 };
    if (info.isThinking) return { state: 'thinking', animation: 'thinking', priority: 6 };
    if (info.isRunning) return { state: 'typing', animation: 'typing', priority: 5 };
    return { state: 'idle', animation: 'idle', priority: 1 };
  }

  function decideStage(stage, now, level, around) {
    if (stage.moment !== null && now >= stage.moment.until) {
      stage.moment = null;
      if (stage.queued !== null) startMoment(stage, stage.queued, now);
      stage.queued = null;
    }
    if (stage.reaction !== null) {
      return { key: stage.reaction.key, mode: stage.reaction.mode, priority: REACTION_PRIORITY };
    }
    const held = stage.moment;
    const pick = held !== null && held.priority >= level.priority ? held : level;
    if (pick.state !== 'idle') {
      stage.asleep = false;
      stage.waking = false;
      stage.extra = null;
      stage.nextExtraAt = 0;
      stage.quietSince = now;
      return { key: pick.animation, mode: 'loop', priority: pick.priority };
    }
    if (!stage.asleep && now - stage.quietSince >= SLEEP_AFTER_MS) {
      stage.asleep = true;
      stage.extra = null;
    }
    if (stage.asleep) return { key: 'sleeping', mode: 'loop', priority: 1 };
    if (stage.waking) return { key: 'waking', mode: 'once', priority: 1 };
    if (stage.extra === null && around.extrasAllowed && around.extras.length > 0) {
      if (stage.nextExtraAt === 0) {
        stage.nextExtraAt = now + EXTRA_MIN_MS + around.random() * EXTRA_SPAN_MS;
      } else if (now >= stage.nextExtraAt) {
        stage.extra = around.extras[Math.floor(around.random() * around.extras.length)];
      }
    }
    if (stage.extra !== null) return { key: stage.extra, mode: 'once', priority: 1 };
    return { key: 'idle', mode: 'loop', priority: 1 };
  }

  function finishStage(stage, key, now, random) {
    if (stage.reaction !== null && stage.reaction.key === key && !stage.reaction.fresh) stage.reaction = null;
    if (stage.extra === key) {
      stage.extra = null;
      stage.nextExtraAt = now + EXTRA_MIN_MS + random() * EXTRA_SPAN_MS;
    }
    if (key === 'waking') stage.waking = false;
  }

  function switchSettles(stage, next, now) {
    const current = stage.current;
    return (
      current === null ||
      current.mode !== 'loop' ||
      current.priority === REACTION_PRIORITY ||
      next.priority > current.priority ||
      now - current.start >= MIN_SHOW_MS
    );
  }

  function nextDecisionAt(stage, now, waitSettle, playMs) {
    let at = Infinity;
    if (stage.moment !== null) at = Math.min(at, stage.moment.until);
    if (waitSettle && stage.current !== null) at = Math.min(at, stage.current.start + MIN_SHOW_MS);
    if (stage.current !== null && stage.current.mode === 'once' && stage.current.done !== true) {
      at = Math.min(at, stage.current.start + playMs(stage.current.key));
    }
    if (!stage.asleep && stage.level !== null && stage.level.state === 'idle') {
      at = Math.min(at, stage.quietSince + SLEEP_AFTER_MS);
    }
    if (stage.extra === null && stage.nextExtraAt > now) at = Math.min(at, stage.nextExtraAt);
    return at;
  }

  function cellSize(sheet, gutter) {
    return [sheet.box[2] + gutter * 2, sheet.box[3] + gutter * 2];
  }

  function frameOffset(sheet, frame, gutter) {
    const [cw, ch] = cellSize(sheet, gutter);
    const cols = sheet.columns || 8;
    return `translate(${-((frame % cols) * cw + gutter) * 2}px, ${-(Math.floor(frame / cols) * ch + gutter) * 2}px)`;
  }

  return {
    MIN_SHOW_MS,
    SLEEP_AFTER_MS,
    EXTRA_MIN_MS,
    EXTRA_SPAN_MS,
    REACTION_PRIORITY,
    CRAB_EXTRAS,
    MOMENTS,
    freshStage,
    takeMoment,
    levelFromActiveInfo,
    decideStage,
    finishStage,
    switchSettles,
    nextDecisionAt,
    cellSize,
    frameOffset,
  };
});
