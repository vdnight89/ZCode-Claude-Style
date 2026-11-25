const hudHistories = new Map();
const hudUnits = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const hudDates = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function hudFiber(element) {
  const key = element && Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber$'));
  const initial = key && element[key];
  if (!initial) return null;
  let rootFiber = initial;
  while (rootFiber.return) rootFiber = rootFiber.return;
  if (rootFiber.stateNode?.current === rootFiber.alternate && initial.alternate) return initial.alternate;
  return initial;
}

function hudProps(element, predicate) {
  for (let fiber = hudFiber(element), depth = 0; fiber && depth < 100; fiber = fiber.return, depth++) {
    if (predicate(fiber.memoizedProps)) return fiber.memoizedProps;
  }
  return null;
}

function hudNative(composer, selectors) {
  const scope = composer.closest(selectors.timeline) || composer.parentElement;
  const marker = composer.querySelector(selectors.hudModel);
  const task = hudProps(composer, props => props?.snapshot?.sessionId && props.sessionId === props.snapshot.sessionId);
  const model = hudProps(marker, props => props?.usage?.contextWindow && props.sessionId);
  const contextButton = composer.querySelector(selectors.hudContext);
  const context = hudProps(contextButton, props => props?.taskUsage || props?.codingPlanUsageRemaining);
  const timeline = hudProps(scope, props => Array.isArray(props?.rows) && props.rowContext?.sessionId === task?.sessionId);
  const services = hudProps(composer, props => typeof props?.value?.zcodeAgentService?.readSessionDebug === 'function')?.value;
  const snapshot = task?.snapshot;
  const sameModel = !snapshot || model?.sessionId === snapshot.sessionId;
  const rows = timeline?.rows || snapshot?.rows?.window;
  const usage = snapshot?.usage ?? (sameModel ? model?.usage : null);
  const fallback = { used: marker?.dataset.usageUsed, max: marker?.dataset.usageMax };
  return {
    task, services, snapshot, usage, fallback, context, remoteSessionId: timeline?.rowContext?.workspaceRemoteSessionId, session: task?.sessionId || model?.sessionId || '',
    model: hudData.modelName(snapshot?.config?.modelSelection ?? snapshot?.config?.model ?? marker?.dataset.model),
    rows: Array.isArray(rows) ? rows : null, totalRows: timeline?.totalCount ?? snapshot?.rows?.totalCount,
  };
}

function hudNumber(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1e6) return hudUnits.format(value / 1e6) + 'M';
  if (Math.abs(value) >= 1000) return hudUnits.format(value / 1000) + 'K';
  return hudUnits.format(value);
}

function hudPercent(fraction) {
  return fraction == null ? '—' : hudUnits.format(fraction * 100) + '%';
}

function hudElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function hudButton(text, action, tooltip) {
  const button = hudElement('button', 'zc-cs-hud-button', text);
  button.type = 'button';
  button.dataset.zcHudAction = action;
  if (tooltip) button.title = tooltip;
  return button;
}

function hudMeter(element, fraction, breakdown = []) {
  const segments = [];
  if (fraction != null) {
    const filled = Math.max(0, Math.min(1, fraction));
    for (const part of breakdown.length ? breakdown : [{ fraction: 1, color: 'primary' }]) {
      const item = hudElement('span', 'zc-cs-hud-meter-part');
      item.dataset.color = part.color;
      item.style.width = (filled * part.fraction * 100) + '%';
      if (part.name) item.title = part.name;
      segments.push(item);
    }
  }
  element.replaceChildren(...segments);
  if (element.getAttribute('role') === 'img') element.setAttribute('aria-label', '已用 ' + hudPercent(fraction));
}

function hudRecord(key, latest, usage, model) {
  if (!key || !latest || usage.used == null || usage.maximum == null) return null;
  if (!hudHistories.has(key)) {
    if (hudHistories.size >= 24) hudHistories.delete(hudHistories.keys().next().value);
    hudHistories.set(key, new Map());
  }
  const history = hudHistories.get(key);
  if (history.size >= 240 && !history.has(latest.id)) history.delete(history.keys().next().value);
  const sameEntry = history.get(latest.id);
  const prior = sameEntry ? sameEntry.prior : [...history.values()].at(-1);
  const matching = prior?.id !== latest.id && prior?.model === model && prior?.maximum === usage.maximum;
  history.set(latest.id, { id: latest.id, context: usage.used, model, maximum: usage.maximum,
    prior: matching ? { id: prior.id, context: prior.context, model: prior.model, maximum: prior.maximum } : null,
    delta: matching ? usage.used - prior.context : null, cache: usage.cache.latestHit });
  return history;
}

function mountHud(composer, surface, composerTop, selectors) {
  const top = hudElement('section', 'zc-cs-hud-root zc-cs-hud-top');
  const bar = hudElement('div', 'zc-cs-hud-meter');
  bar.setAttribute('role', 'img');
  const stats = hudElement('div', 'zc-cs-hud-stats');
  const remaining = hudElement('strong', 'zc-cs-hud-remaining');
  const used = hudElement('span');
  const cache = hudElement('span');
  const speed = hudElement('span');
  const compact = hudButton('/compact', 'compact', '填入压缩命令');
  stats.append(remaining, used, cache, speed, compact);
  top.append(bar, stats);

  const footer = hudElement('div', 'zc-cs-hud-root zc-cs-hud-footer');
  const cumulative = hudElement('span');
  const calls = hudElement('span');
  const output = hudElement('span', 'zc-cs-hud-output');
  const quotaInline = hudElement('span', 'zc-cs-hud-quotas');
  const quotaShort = hudElement('span');
  const quotaWeekly = hudElement('span');
  quotaInline.append(quotaShort, quotaWeekly);
  const opener = hudButton('用量详情', 'open', '展开上下文窗口与 Token 监控');
  opener.setAttribute('aria-haspopup', 'dialog');
  opener.setAttribute('aria-expanded', 'false');
  footer.append(cumulative, calls, output, quotaInline, opener);

  const rim = hudElement('div', 'zc-cs-hud-root zc-cs-hud-rim');
  const rimFill = hudElement('span');
  rim.append(rimFill);
  rim.setAttribute('aria-hidden', 'true');

  const panel = hudElement('section', 'zc-cs-hud-root zc-cs-hud-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '上下文窗口与 Token 监控');
  const header = hudElement('header', 'zc-cs-hud-head');
  const title = hudElement('h2', null, '上下文窗口与 Token 监控');
  const actions = hudElement('div', 'zc-cs-hud-actions');
  const copy = hudButton('复制报告', 'copy');
  const refresh = hudButton('刷新', 'refresh');
  const close = hudButton('×', 'close', '关闭监控');
  close.setAttribute('aria-label', '关闭监控');
  actions.append(hudButton('/compact', 'compact', '填入压缩命令'), copy, refresh, close);
  header.append(title, actions);
  const summary = hudElement('div', 'zc-cs-hud-summary');
  const tabs = hudElement('div', 'zc-cs-hud-tabs');
  const tabLabels = { overall: '上下文拆分', turns: '对话轮次', tools: '工具 / 代理', quota: '模型配额' };
  for (const [key, label] of Object.entries(tabLabels)) tabs.append(hudButton(label, key));
  const body = hudElement('div', 'zc-cs-hud-body');
  const feedback = hudElement('div', 'zc-cs-hud-feedback');
  feedback.setAttribute('role', 'status');
  panel.append(header, summary, tabs, body, feedback);
  composerTop.prepend(top);
  composer.append(footer);
  surface.prepend(rim);
  document.body.append(panel);

  let current;
  let disposed = false;
  let selected = 'overall';
  let cursor = null;
  let rawRows;
  let totalRows;
  let sessionRows = hudData.rowSummary([], 0);
  let debug = hudData.nativeRounds(null);
  let debugKey = '';
  let pendingDebug = null;
  let lastDebugAt = 0;
  let lastDebugMarker = '';
  let lastAgentsAt = 0;
  let agentDirectory;
  let agentMetrics = new Map();
  let pendingAgents;
  let topSignature;
  let panelSignature;

  function applyDebugToTurns(rows, history, accountDebug) {
    const grouped = new Map();
    for (const request of accountDebug.turns) {
      const key = rows.rawToProduct.get(request.key) || request.key;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(request);
    }
    return rows.turns.map(turn => {
      const records = grouped.get(turn.id) || [];
      const sample = history?.get(turn.id);
      const input = hudData.addNumbers(records.map(row => row.input));
      const read = hudData.addNumbers(records.map(row => row.read));
      const thinking = hudData.addNumbers(records.map(row => row.thinking));
      const measuredSpeed = records.findLast(record => record.speed != null)?.speed;
      return { ...turn, context: sample?.context ?? null, delta: sample?.delta ?? null,
        cache: input > 0 && read != null ? Math.min(1, read / input) : sample?.cache ?? null, thinking, speed: measuredSpeed ?? turn.speed,
        speedMeasured: measuredSpeed != null };
    });
  }

  async function loadDebug(native, force, marker) {
    const service = native.services?.zcodeAgentService;
    const task = native.task;
    const changed = marker !== lastDebugMarker;
    if (!service || !task?.workspacePath || !native.session || pendingDebug?.key === native.session) return;
    if (!force && ((panel.hidden && !changed) || Date.now() - lastDebugAt < (changed ? 3000 : 8000))) return;
    const key = native.session;
    const ticket = { key };
    pendingDebug = ticket;
    lastDebugAt = Date.now();
    lastDebugMarker = marker;
    try {
      const result = await service.readSessionDebug({
        workspacePath: task.workspacePath, workspaceIdentity: task.workspaceIdentity, sessionId: key,
      });
      if (!disposed && pendingDebug === ticket && debugKey === key) debug = hudData.nativeRounds(result);
    } catch {
      // The host can omit debug records on restored conversations or unsupported providers.
    } finally {
      if (pendingDebug === ticket) pendingDebug = null;
      if (!disposed && debugKey === key) update();
    }
  }

  async function loadAgents(native, force) {
    const service = native.services?.zcodeAgentService;
    const workspacePath = native.task?.workspacePath;
    if (typeof service?.listSessionSubagents !== 'function' || !workspacePath || !native.session ||
        pendingAgents || !force && Date.now() - lastAgentsAt < 12000) return;
    const ticket = { session: native.session };
    pendingAgents = ticket;
    lastAgentsAt = Date.now();
    const workspace = { workspacePath, workspaceIdentity: native.task.workspaceIdentity };
    const valid = () => !disposed && pendingAgents === ticket && debugKey === ticket.session;
    try {
      const directory = await service.listSessionSubagents({ ...workspace, sessionId: ticket.session,
        ...(native.remoteSessionId ? { remoteSessionId: native.remoteSessionId } : {}), endedLimit: 20 });
      if (!valid()) return;
      agentDirectory = directory;
      const running = directory.running || [];
      const related = [...running, ...(directory.ended?.items || [])];
      const candidates = related.filter(item => item.childSessionId && !item.usage && !item.tokenUsage &&
        (!agentMetrics.has(item.childSessionId) || running.includes(item))).slice(0, 6);
      for (const item of candidates) {
        if (!valid()) break;
        try {
          const child = await service.readSessionDebug({ ...workspace, sessionId: item.childSessionId });
          if (!valid()) continue;
          if (!child?.rounds?.length) {
            agentMetrics.set(item.childSessionId, null);
            continue;
          }
          const count = key => hudData.addNumbers(child.rounds.map(round => hudData.number(round.usage?.[key])));
          agentMetrics.set(item.childSessionId, { requestCount: child.rounds.length,
            totalTokens: count('totalTokens'), inputTokens: count('inputTokens'), outputTokens: count('outputTokens') });
        } catch {
          // Older child sessions may lack debug records.
        }
      }
    } catch {
      // Keep the values already provided by the current projection.
    } finally {
      const apply = valid();
      if (pendingAgents === ticket) pendingAgents = null;
      if (apply) update();
    }
  }

  function update(force = false) {
    if (disposed || (document.hidden && !force)) return;
    const native = hudNative(composer, selectors);
    const usage = hudData.usageSummary(native.usage, native.context?.taskUsage, native.fallback);
    const available = !!native.session && (usage.fraction != null || native.rows?.length > 0);
    top.hidden = !available;
    footer.hidden = !available;
    rim.hidden = usage.fraction == null;
    if (!available) {
      setOpen(false, false);
      return;
    }
    if (debugKey !== native.session) {
      debugKey = native.session;
      debug = hudData.nativeRounds(null);
      lastDebugAt = 0;
      lastDebugMarker = '';
      lastAgentsAt = 0;
      agentDirectory = null;
      agentMetrics = new Map();
      pendingAgents = null;
      pendingDebug = null;
      rawRows = null;
    }
    if (rawRows !== native.rows || totalRows !== native.totalRows) {
      rawRows = native.rows;
      totalRows = native.totalRows;
      sessionRows = hudData.rowSummary(rawRows || [], totalRows);
    }
    const latest = sessionRows.turns.at(-1);
    const history = hudRecord(native.session, latest, usage, latest?.model || native.model);
    const turns = applyDebugToTurns(sessionRows, history, debug);
    if (usage.cumulative.output == null || usage.cumulative.inputFromCache) {
      const observedOutput = hudData.addNumbers(turns.map(turn => turn.output));
      const original = usage.cumulative.output;
      usage.cumulative.output = observedOutput == null ? original : Math.max(original ?? 0, observedOutput);
      usage.cumulative.outputEstimated = observedOutput != null && observedOutput >= (original ?? 0) &&
        turns.some(turn => turn.outputEstimated);
      usage.cumulative.outputPartial = sessionRows.loadedRows < sessionRows.totalRows ||
        turns.some(turn => turn.output == null) || observedOutput == null;
    }
    usage.cumulative.total = usage.cumulative.input != null && usage.cumulative.output != null
      ? usage.cumulative.input + usage.cumulative.output : null;
    const measuredSpeed = debug.speed;
    const lastTimed = turns.findLast(turn => turn.speed != null);
    const displaySpeed = measuredSpeed ?? lastTimed?.speed ?? null;
    current = { ...sessionRows, ...usage, turns, latest: turns.at(-1), model: native.model,
      quotas: hudData.quotaSummary(native.context?.codingPlanUsageRemaining),
      agents: hudData.subagentSummary(agentDirectory ?? native.snapshot?.subagents, agentMetrics), displaySpeed,
      speedEstimated: measuredSpeed == null && displaySpeed != null, debug };
    const summaryKey = JSON.stringify([usage, turns.length, sessionRows.toolCalls, displaySpeed, current.speedEstimated,
      turns.at(-1)?.requests, current.quotas.map(quota => [quota.name, quota.displayPercent])]);
    if (topSignature !== summaryKey) {
      topSignature = summaryKey;
      drawTop(current);
    }
    if (!panel.hidden) {
      position();
      const panelKey = JSON.stringify([selected, summaryKey, current.agents, current.quotas, debug,
        selected === 'turns' ? turns : selected === 'tools' ? current.ranking : null]);
      if (panelSignature !== panelKey) {
        panelSignature = panelKey;
        drawPanel(current);
      }
      if (selected === 'tools') void loadAgents(native, force);
    }
    const marker = JSON.stringify([latest?.id, latest?.requests, native.usage?.cumulative, usage.cache.requests]);
    void loadDebug(native, force, marker);
  }

  function risk(data) {
    return data.fraction == null ? '' : data.fraction <= .10 ? 'danger' : data.fraction <= .20 ? 'low' : '';
  }

  function speedText(data) {
    return data.displaySpeed == null ? '— tok/s' : (data.speedEstimated ? '~' : '') + hudNumber(data.displaySpeed) + ' tok/s';
  }

  function cumulativeText(data, field) {
    const value = data.cumulative[field];
    const uncertain = field !== 'input' && (data.cumulative.outputEstimated || data.cumulative.outputPartial);
    return (uncertain && value != null ? '~' : '') + hudNumber(value);
  }

  function turnOutput(turn) {
    return (turn.outputEstimated ? '~' : '') + hudNumber(turn.output);
  }

  function drawTop(data) {
    top.dataset.risk = risk(data);
    const consumed = data.fraction == null ? null : 1 - data.fraction;
    hudMeter(bar, consumed, data.breakdown);
    rimFill.style.width = ((consumed ?? 0) * 100) + '%';
    remaining.textContent = '剩余 ' + hudPercent(data.fraction) +
      (data.maximum ? ' (' + hudNumber(data.available) + ' / ' + hudNumber(data.maximum) + ')' : '');
    used.textContent = '已用 ' + hudNumber(data.used);
    cache.textContent = '缓存 ' + hudPercent(data.cache.hit);
    speed.textContent = speedText(data);
    compact.disabled = !data.maximum;
    cumulative.textContent = '累计吞吐 ' + cumulativeText(data, 'total');
    cumulative.title = '累计输入与输出，重复送入上下文的输入会计入';
    const requestCount = hudData.addNumbers(data.turns.map(turn => turn.requests));
    calls.textContent = data.turns.length + ' 轮 / ' + hudNumber(requestCount) + ' 次调用';
    output.textContent = '输出 ' + cumulativeText(data, 'output');
    const fiveHour = data.quotas.find(quota => quota.name === '5 小时');
    const weekly = data.quotas.find(quota => quota.name === '每周');
    const first = fiveHour ?? (weekly ? null : data.quotas[0]);
    quotaShort.hidden = !first;
    quotaShort.textContent = first ? (fiveHour ? '5小时' : first.name) + ' ' + first.displayPercent + '%' : '';
    quotaWeekly.hidden = !weekly;
    quotaWeekly.textContent = weekly ? '每周 ' + weekly.displayPercent + '%' : '';
    quotaInline.hidden = !first && !weekly;
    footer.classList.toggle('zc-cs-hud-dual-quota', !!fiveHour && !!weekly);
    opener.textContent = '用量详情 ▴';
  }

  function metric(label, value, note) {
    const item = hudElement('div', 'zc-cs-hud-metric');
    item.append(hudElement('span', null, label), hudElement('strong', null, value));
    if (note) item.append(hudElement('small', null, note));
    return item;
  }

  function rankingRow(name, value, fraction, color = 'primary', note) {
    const row = hudElement('div', 'zc-cs-hud-rank-row');
    const line = hudElement('div', 'zc-cs-hud-line');
    line.append(hudElement('span', null, name), hudElement('strong', null, value));
    if (note) row.title = note;
    const meter = hudElement('div', 'zc-cs-hud-meter');
    hudMeter(meter, fraction, [{ fraction: 1, color }]);
    row.append(line, meter);
    return row;
  }

  function overallPane(data) {
    const grid = hudElement('div', 'zc-cs-hud-grid');
    grid.append(
      metric('剩余可用容量', hudNumber(data.available) + ' (' + hudPercent(data.fraction) + ')',
        '已用 ' + hudNumber(data.used) + ' / ' + hudNumber(data.maximum)),
      metric('平均缓存命中率', hudPercent(data.cache.hit), '最新读取 ' + hudNumber(data.cache.read)),
      metric('生成吞吐速度', speedText(data), data.debug.firstTokenMs != null
        ? '首字延迟 ' + hudNumber(data.debug.firstTokenMs) + ' ms'
        : data.speedEstimated ? '根据轮次输出与模型耗时计算' : ''),
      metric('会话累计消耗', cumulativeText(data, 'total'),
        '输入 ' + cumulativeText(data, 'input') + ' · 输出 ' + cumulativeText(data, 'output')));
    body.append(grid, hudElement('h3', null, '上下文窗口构成'));
    if (!data.breakdown.length) {
      body.append(hudElement('p', 'zc-cs-hud-note', '当前上下文来源未上报。以下按已载入历史估算。'));
      const entries = [
        ['对话消息', data.messageTokens, 'messages'],
        ['可见思考文本', data.reasoningTokens, 'system'],
        ['工具输出', data.toolTokens, 'tools'],
      ].filter(([, tokens]) => tokens > 0);
      const total = entries.reduce((sum, [, tokens]) => sum + tokens, 0);
      for (const [name, tokens, color] of entries) {
        body.append(rankingRow(name, '~' + hudNumber(tokens) + ' tok', tokens / total, color));
      }
    } else {
      for (const part of data.breakdown) {
        body.append(rankingRow(part.name, hudPercent(part.fraction), part.fraction, part.color));
      }
      body.append(hudElement('p', 'zc-cs-hud-note', '占比按 ZCode 返回的字符数计算。'));
    }
    const latest = hudElement('div', 'zc-cs-hud-grid');
    const cached = data.debug.read ?? data.cache.read;
    const input = data.debug.input ?? data.cache.input;
    latest.append(metric('新输入', input != null && cached != null ? hudNumber(Math.max(0, input - cached)) : '—'),
      metric('缓存读取', hudNumber(cached)), metric('回复输出', data.debug.output != null ? hudNumber(data.debug.output) : data.latest ? turnOutput(data.latest) : '—',
        data.debug.output == null && data.latest?.output != null ? '最新对话轮次' : ''),
      metric('思考 Token', hudNumber(data.debug.thinking)));
    body.append(hudElement('h3', null, '最新调用指标'), latest);
  }

  function turnsPane(data) {
    if (!data.turns.length) body.append(hudElement('p', 'zc-cs-hud-note', '当前没有可读的轮次。'));
    for (const turn of data.turns.slice(-120).reverse()) {
      const card = hudElement('article', 'zc-cs-hud-turn');
      const line = hudElement('div', 'zc-cs-hud-line');
      const tag = hudElement('strong', 'zc-cs-hud-turn-id', '#T' + turn.index);
      const who = hudElement('span', 'zc-cs-hud-turn-model', turn.model ||
        (turn.origin === 'backgroundResult' ? '后台续跑' : ''));
      const delta = turn.delta == null ? '—' : (turn.delta > 0 ? '+' : '') + hudNumber(turn.delta);
      const context = hudElement('strong', 'zc-cs-hud-turn-context', '上下文 ' + hudNumber(turn.context) + ' ' + delta);
      line.append(tag, who, context);
      card.append(line);
      if (turn.preview) card.append(hudElement('div', 'zc-cs-hud-turn-preview', turn.preview));
      const thinking = turn.thinking != null ? hudNumber(turn.thinking)
        : turn.estimatedThinking > 0 ? '~' + hudNumber(turn.estimatedThinking) : '—';
      const stats = ['输出 ' + turnOutput(turn), '思考 ' + thinking, '工具 ×' + turn.toolCount,
        '模型请求 ×' + hudNumber(turn.requests), turn.speed != null ? (turn.speedMeasured ? '' : '~') + hudNumber(turn.speed) + ' tok/s' : '',
        '缓存 ' + hudPercent(turn.cache)].filter(Boolean).join(' · ');
      card.append(hudElement('div', 'zc-cs-hud-note', stats));
      body.append(card);
    }
    const coverage = data.loadedRows < data.totalRows ? '当前载入 ' + data.loadedRows + ' / ' + data.totalRows + ' 条记录。' : '';
    body.append(hudElement('p', 'zc-cs-hud-note', coverage + '历史上下文和缓存缺项显示 —；~ 表示估算。'));
  }

  function toolsPane(data) {
    const agents = data.agents.items;
    const count = Math.max(agents.length, data.agents.known ?? 0, data.agents.ended ?? 0);
    const total = hudData.addNumbers(agents.map(agent => agent.total));
    body.append(hudElement('h3', null, '子代理消耗 (' + count + ' 个 · ' + hudNumber(count === 0 ? 0 : total) + ' tok)'));
    if (agents.length < count && agents.length > 0) {
      body.append(hudElement('p', 'zc-cs-hud-note', '当前显示 ' + agents.length + ' / ' + count + ' 个子代理。'));
    }
    if (!agents.length) {
      body.append(hudElement('p', 'zc-cs-hud-note', count ? '当前未载入子代理明细。' : '当前没有关联的子代理记录。'));
    }
    for (const agent of agents) {
      const card = hudElement('article', 'zc-cs-hud-turn');
      const line = hudElement('div', 'zc-cs-hud-line');
      line.append(hudElement('strong', null, agent.name + (agent.running ? ' · 运行中' : '')),
        hudElement('span', null, hudNumber(agent.total) + ' tok'));
      card.append(line, hudElement('div', 'zc-cs-hud-note', [agent.model, '请求 ' + hudNumber(agent.requests),
        '输出 ' + hudNumber(agent.output)].filter(Boolean).join(' · ')));
      body.append(card);
    }
    body.append(hudElement('h3', null, '工具输出体积排行 (~' + hudNumber(data.toolTokens) + ' tok)'));
    if (!data.ranking.length) body.append(hudElement('p', 'zc-cs-hud-note', '当前没有可读的工具调用。'));
    const max = Math.max(1, data.ranking[0]?.tokens ?? 0);
    for (const tool of data.ranking) {
      const markers = [tool.clipped ? '截断 ' + tool.clipped : '', tool.missing ? '无输出文本 ' + tool.missing : ''].filter(Boolean);
      const label = tool.name + ' ×' + tool.count + (markers.length ? ' · ' + markers.join(' · ') : '');
      body.append(rankingRow(label, tool.tokens > 0 ? '~' + hudNumber(tool.tokens) : '—', tool.tokens / max, 'tools'));
    }
    const coverage = data.loadedRows < data.totalRows ? '当前载入 ' + data.loadedRows + ' / ' + data.totalRows + ' 条记录。' : '';
    body.append(hudElement('p', 'zc-cs-hud-note', coverage + '按已保留的工具输出文本估算体积。'));
  }

  function quotaPane(data) {
    if (!data.quotas.length) body.append(hudElement('p', 'zc-cs-hud-note', '当前模型未返回可用配额。'));
    for (const quota of data.quotas) {
      const reset = quota.reset ? ' · ' + hudDates.format(new Date(quota.reset < 1e12 ? quota.reset * 1000 : quota.reset)) + ' 重置' : '';
      body.append(rankingRow(quota.name, '剩余 ' + hudPercent(quota.fraction) + reset, quota.fraction));
    }
  }

  function drawPanel(data) {
    const scrollTop = body.scrollTop;
    summary.replaceChildren();
    if (data.model) summary.append(hudElement('div', 'zc-cs-hud-model', data.model));
    const status = hudElement('div', 'zc-cs-hud-line');
    status.append(hudElement('strong', 'zc-cs-hud-remaining', '剩余可用 ' + hudNumber(data.available) + ' / ' +
      hudNumber(data.maximum) + ' (' + hudPercent(data.fraction) + ')'),
    hudElement('span', null, '已用 ' + hudNumber(data.used)));
    summary.append(status);
    const warning = risk(data);
    summary.dataset.risk = warning;
    if (warning) {
      const notice = hudButton('上下文仅剩 ' + hudPercent(data.fraction) + '，填入 /compact', 'compact');
      notice.classList.add('zc-cs-hud-warning');
      summary.append(notice);
    }
    if (data.quotas[0]) summary.append(hudElement('div', 'zc-cs-hud-note',
      '额度剩余 ' + hudPercent(data.quotas[0].fraction) + ' · ' + data.quotas[0].name));
    const meter = hudElement('div', 'zc-cs-hud-meter');
    hudMeter(meter, data.fraction == null ? null : 1 - data.fraction, data.breakdown);
    summary.append(meter);
    for (const button of tabs.children) {
      const key = button.dataset.zcHudAction;
      const count = key === 'turns' ? data.turns.length : key === 'tools' ? data.ranking.length + data.agents.items.length : null;
      button.textContent = tabLabels[key] + (count == null ? '' : ' (' + count + ')');
      button.setAttribute('aria-pressed', String(selected === key));
    }
    body.replaceChildren();
    ({ overall: overallPane, turns: turnsPane, tools: toolsPane, quota: quotaPane })[selected](data);
    body.scrollTop = scrollTop;
  }

  function position() {
    if (panel.hidden) return;
    const bounds = surface.getBoundingClientRect();
    const width = Math.min(510, window.innerWidth - 24);
    const anchorTop = Math.min(bounds.top - 10, window.innerHeight - 12);
    const availableHeight = anchorTop - 12;
    panel.style.width = width + 'px';
    panel.style.left = Math.max(12, Math.min(window.innerWidth - width - 12, bounds.right - width)) + 'px';
    panel.style.bottom = (availableHeight < 320 ? 12 : window.innerHeight - anchorTop) + 'px';
    panel.style.maxHeight = Math.min(810, availableHeight < 320 ? window.innerHeight - 24 : availableHeight) + 'px';
  }

  function setOpen(open, restoreFocus = true) {
    if (open === !panel.hidden) return;
    panel.hidden = !open;
    opener.setAttribute('aria-expanded', String(open));
    if (open) {
      feedback.textContent = '';
      cursor = document.activeElement;
      update(true);
      close.focus({ preventScroll: true });
    } else if (restoreFocus && cursor?.isConnected && panel.contains(document.activeElement)) {
      cursor.focus({ preventScroll: true });
    }
  }

  function fillCompact() {
    const editor = composer.querySelector(selectors.editor);
    const input = hudProps(editor, props => typeof props?.inputApiRef?.current?.setText === 'function')?.inputApiRef.current;
    if (!input || !editor || editor.getAttribute('contenteditable') !== 'true') {
      if (panel.hidden) setOpen(true, false);
      feedback.textContent = '当前输入框不可编辑。';
      return;
    }
    if ((input.getMarkdown?.() || input.getText?.() || editor.textContent).trim()) {
      if (panel.hidden) setOpen(true, false);
      feedback.textContent = '已有草稿，请保留草稿后再填入 /compact。';
      return;
    }
    input.setText('/compact');
    setOpen(false, false);
    input.focus();
  }

  function reportText() {
    const data = current;
    const lines = ['ZCode 上下文窗口与 Token 监控',
      '模型 ' + (data.model || '—'),
      '上下文 ' + hudNumber(data.used) + ' / ' + hudNumber(data.maximum) + ' · 剩余 ' + hudPercent(data.fraction),
      '累计输入 ' + cumulativeText(data, 'input') + ' · 输出 ' + cumulativeText(data, 'output') +
        ' · 吞吐 ' + cumulativeText(data, 'total'),
      '平均缓存命中率 ' + hudPercent(data.cache.hit) + ' · ' + speedText(data),
      '', '上下文来源', ...data.breakdown.map(part => part.name + ' ' + hudPercent(part.fraction)),
      '', '对话轮次', ...data.turns.slice(-120).map(turn => '#T' + turn.index + ' 上下文 ' + hudNumber(turn.context) +
        ' · 输出 ' + turnOutput(turn) + ' · 工具 ×' + turn.toolCount),
      '', '工具输出估算', ...data.ranking.map(tool => tool.name + ' ×' + tool.count + ' ~' + hudNumber(tool.tokens)),
      '记录覆盖 ' + data.loadedRows + ' / ' + data.totalRows,
      '', '模型配额', ...data.quotas.map(quota => quota.name + ' ' + hudPercent(quota.fraction))];
    return lines.join('\n');
  }

  async function onAction(event) {
    const key = event.target.closest?.('button[data-zc-hud-action]')?.dataset.zcHudAction;
    if (!key) return;
    if (key === 'open') setOpen(panel.hidden);
    if (key === 'close') setOpen(false);
    if (key === 'compact') fillCompact();
    if (key === 'refresh') update(true);
    if (key === 'copy' && current) {
      try {
        await navigator.clipboard.writeText(reportText());
        if (!disposed) feedback.textContent = '已复制报告';
      } catch {
        if (!disposed) feedback.textContent = '剪贴板不可用';
      }
    }
    if (Object.hasOwn(tabLabels, key)) {
      selected = key;
      body.scrollTop = 0;
      update(true);
    }
  }

  const outside = event => {
    if (!panel.hidden && ![panel, footer, top].some(node => node.contains(event.target))) setOpen(false, false);
  };
  const escape = event => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
    }
  };
  const onVisibility = () => update();
  for (const node of [top, footer, panel]) node.addEventListener('click', onAction);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', position);
  const timer = setInterval(update, 1000);
  function destroy() {
    disposed = true;
    clearInterval(timer);
    for (const node of [top, footer, panel]) node.removeEventListener('click', onAction);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', position);
    for (const node of [top, footer, rim, panel]) node.remove();
  }

  try {
    update(true);
  } catch (error) {
    destroy();
    throw error;
  }
  return destroy;
}
