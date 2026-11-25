'use strict';

const sources = {
  messages: ['对话消息', 'messages'],
  system_prompt: ['系统提示词', 'system'],
  meta_user_context: ['其他上下文', 'other'],
  skills: ['技能', 'skills'],
  tool_prompt: ['工具提示词', 'tools'],
  system_tool_schemas: ['系统工具定义', 'tools'],
  mcp_tool_schemas: ['MCP 工具定义', 'mcp'],
};

function number(value) {
  if (typeof value !== 'string' && typeof value !== 'number' || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function ratio(value) {
  const parsed = number(value);
  return parsed == null || parsed > 1 ? null : parsed;
}

function addNumbers(values) {
  const valid = values.filter(value => value != null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) : null;
}

// Same approximate CJK/other ratios as the AGY usage core.
function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g)?.length || 0;
  return Math.max(1, Math.round(cjk * 0.68 + (text.length - cjk) * 0.27));
}

function makeBreakdown(parts) {
  const totals = new Map();
  for (const part of Array.isArray(parts) ? parts : []) {
    const chars = number(part?.chars);
    if (!chars || typeof part.source !== 'string') continue;
    const key = Object.hasOwn(sources, part.source) ? part.source : 'other';
    totals.set(key, (totals.get(key) || 0) + chars);
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals].map(([source, chars]) => {
    const [name, color] = sources[source] || ['其他上下文', 'other'];
    return { name, color, chars, fraction: chars / total };
  }).sort((a, b) => b.chars - a.chars);
}

function modelName(value) {
  const name = value?.modelId ?? value?.label ?? value;
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}

function turnKey(row) {
  return row?.productTurnId || row?.turnId || null;
}

function toolResult(row) {
  const output = row.output;
  const text = typeof output?.text === 'string' ? output.text : typeof output === 'string' ? output : '';
  const clipped = output?.truncated === true || output?.display?.truncated === true ||
    /(?:output truncated|输出已截断|\btruncated\b.*\bchars\b)/i.test(text.slice(-320));
  return { tokens: estimateTokens(text), reported: text.length > 0,
    clipped };
}

function rowSummary(rows, totalRows) {
  const turnsById = new Map();
  const toolCalls = new Map();
  const rawToProduct = new Map();
  let messageTokens = 0;
  let reasoningTokens = 0;
  for (const row of rows) {
    if (row?.turnId && row.productTurnId) rawToProduct.set(row.turnId, row.productTurnId);
  }
  const keyFor = row => rawToProduct.get(row.turnId) || turnKey(row);
  for (const row of rows) {
    if (!row || !['turnHeader', 'userInput'].includes(row.kind)) continue;
    const key = keyFor(row);
    for (const id of [row.entityId, row.sourceCommandId]) {
      if (id && key && !rawToProduct.has(id)) rawToProduct.set(id, key);
    }
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = keyFor(row);
    if (!key) continue;
    if (!turnsById.has(key)) {
      turnsById.set(key, { id: key, order: number(row.rowId) ?? turnsById.size,
        headers: new Map(), toolCount: 0, model: '', preview: '', estimatedThinking: 0, estimatedOutput: 0 });
    }
    const turn = turnsById.get(key);
    if (row.kind === 'turnHeader') {
      turn.headers.set(row.turnId || row.rowId, row);
      turn.origin = row.origin;
      turn.status = row.state;
    }
    if (row.kind === 'userInput' && !turn.preview) {
      turn.preview = typeof row.text === 'string' ? row.text.slice(0, 260).replace(/\s+/g, ' ').trim().slice(0, 110) : '';
      turn.model = modelName(row.modelSelection);
    }
    if (row.kind === 'userInput') messageTokens += estimateTokens(row.text);
    if (row.kind === 'assistantText') {
      const estimated = estimateTokens(row.text);
      turn.estimatedOutput += estimated;
      messageTokens += estimated;
    }
    if (row.kind === 'reasoning') {
      const estimated = estimateTokens(row.text);
      turn.estimatedThinking += estimated;
      reasoningTokens += estimated;
    }
    if (row.kind === 'toolCall') {
      const id = row.toolCallId || row.entityId || row.rowId;
      if (id != null) toolCalls.set(id, { key, row });
    }
  }

  const tools = new Map();
  for (const { key, row } of toolCalls.values()) {
    const name = typeof row.toolName === 'string' && row.toolName.trim() ? row.toolName.trim().slice(0, 92) : '未知工具';
    if (!tools.has(name)) tools.set(name, { name, count: 0, tokens: 0, missing: 0, clipped: 0 });
    const tool = tools.get(name);
    const result = toolResult(row);
    tool.count++;
    tool.tokens += result.tokens;
    if (!result.reported) tool.missing++;
    if (result.clipped) tool.clipped++;
    turnsById.get(key).toolCount++;
  }

  const turns = [...turnsById.values()].sort((a, b) => a.order - b.order)
    .filter(turn => turn.headers.size || turn.preview || turn.toolCount)
    .map((turn, index) => {
      const headers = [...turn.headers.values()];
      const requests = addNumbers(headers.map(row => number(row.historyRoundCount)));
      const nativeOutput = addNumbers(headers.map(row => number(row.outputTokens)));
      const outputEstimated = turn.estimatedOutput > 0 && !nativeOutput;
      const output = outputEstimated ? turn.estimatedOutput : nativeOutput;
      const modelMs = addNumbers(headers.map(row => number(row.modelDurationMs)));
      const hasCompleteTiming = headers.length && headers.every(row => number(row.modelDurationMs) > 0);
      const speed = output != null && modelMs > 0 && hasCompleteTiming ? output * 1000 / modelMs : null;
      return { id: turn.id, index: index + 1, model: turn.model, preview: turn.preview,
        origin: turn.origin, status: turn.status, requests, output, outputEstimated, estimatedThinking: turn.estimatedThinking,
        toolCount: turn.toolCount, speed, modelMs, cache: null, thinking: null, context: null, delta: null };
    });
  const ranking = [...tools.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count || a.name.localeCompare(b.name));
  return { turns, ranking, loadedRows: rows.length, totalRows: Math.max(number(totalRows) ?? rows.length, rows.length),
    messageTokens, reasoningTokens, toolCalls: toolCalls.size, toolTokens: ranking.reduce((sum, item) => sum + item.tokens, 0), rawToProduct };
}

function usageSummary(usage, native, fallback = {}) {
  const context = usage?.contextWindow;
  const used = number(context?.usedTokens ?? native?.used ?? fallback.used);
  const limit = number(context?.maxTokens ?? native?.size ?? fallback.max);
  const maximum = limit && limit > 0 ? limit : null;
  const available = used != null && maximum != null ? Math.max(0, maximum - used) : null;
  const cumulative = usage?.cumulative;
  const cache = context?.cache ?? native?.cache;
  const nativeInput = number(cumulative?.inputTokens) || 0;
  const measuredCacheInput = number(cache?.totalInputTokens) || 0;
  const input = Math.max(nativeInput, measuredCacheInput) || null;
  const output = number(cumulative?.outputTokens) || null;
  return {
    used, maximum, available, fraction: available != null ? available / maximum : null,
    compactThreshold: number(context?.autoCompactThresholdTokens),
    cumulative: { input, output, inputFromCache: measuredCacheInput > nativeInput, total: input != null && output != null ? input + output : null,
      cacheRead: number(cumulative?.cacheReadTokens), cacheWrite: number(cumulative?.cacheWriteTokens) },
    cache: { hit: ratio(cache?.hitRate), latestHit: ratio(cache?.latestHitRate),
      requests: number(cache?.hitRateRequestCount),
      input: number(cache?.inputTokens), lastWrite: number(cache?.cacheWriteTokens), read: number(cache?.cacheReadTokens), write: number(cache?.cacheWriteTokens) },
    breakdown: makeBreakdown(native?.breakdown ?? context?.breakdown),
  };
}

function quotaSummary(plan) {
  const entitlements = Array.isArray(plan?.entitlements) ? plan.entitlements : [];
  const selected = entitlements.find(item => item.providerId === plan?.selectedProviderId);
  // Quota is account-scoped. Never substitute limits from a different provider.
  const entitlement = selected || (!plan?.selectedProviderId && entitlements.length === 1 ? entitlements[0] : null);
  const snapshot = entitlement?.snapshot;
  if (!snapshot || snapshot.authenticated === false) return [];
  const items = Array.isArray(snapshot.quota?.limits) ? [...snapshot.quota.limits] : [];
  if (snapshot.mcpQuota?.aggregate) items.push({ ...snapshot.mcpQuota.aggregate, mcp: true });
  return items.flatMap((item, index) => {
    const remaining = number(item.remaining);
    const limit = number(item.usage);
    if (remaining == null || !limit) return [];
    const count = number(item.number) ?? 1;
    const name = item.mcp ? 'ZCode MCP' : item.unit === 3 ? count + ' 小时'
      : item.unit === 6 ? (count === 1 ? '每周' : count + ' 周') : '额度 ' + (index + 1);
    const fraction = Math.min(1, remaining / limit);
    const consumed = number(item.percentage);
    const displayPercent = consumed != null && consumed <= 100 ? Math.round(100 - consumed) : Math.round(fraction * 100);
    return [{ name, fraction, displayPercent, remaining, limit, reset: number(item.nextResetTime) }];
  });
}

function subagentSummary(state, childMetrics) {
  const items = new Map();
  for (const [running, rows] of [[false, state?.ended?.items ?? state?.ended], [true, state?.running]]) {
    for (const item of Array.isArray(rows) ? rows : []) {
      if (!item || typeof item !== 'object') continue;
      const key = item.childSessionId || item.sessionId || item.agentId || item.id;
      if (!key) continue;
      const usage = item.usage ?? item.tokenUsage ?? childMetrics?.get(key);
      const output = number(usage?.outputTokens ?? item.outputTokens);
      const explicitTotal = number(usage?.totalTokens ?? item.totalTokens);
      const input = number(usage?.inputTokens);
      const total = explicitTotal ?? (input != null && output != null ? input + output : null);
      const label = item.name ?? item.title ?? item.label ?? item.agentType ?? item.type;
      items.set(key, { name: typeof label === 'string' ? label.slice(0, 80) : '子代理 ' + (items.size + 1),
        model: modelName(item.modelSelection ?? item.model), running, total, output,
        requests: number(item.requestCount ?? item.calls ?? usage?.requestCount) });
    }
  }
  return { items: [...items.values()], ended: number(state?.endedTotal ?? state?.ended?.total), known: number(state?.childSessionIds?.length) };
}

function nativeRounds(debug) {
  const rounds = Array.isArray(debug?.rounds) ? debug.rounds : [];
  const last = rounds.at(-1);
  const requestEvents = new Map();
  for (const item of Array.isArray(debug?.networkEntries) ? debug.networkEntries : []) {
    if (!item?.requestId) continue;
    const existing = requestEvents.get(item.requestId);
    if (!existing || (item.statusType ?? item.status) === 'model_request_completed') {
      requestEvents.set(item.requestId, item);
    }
  }
  const latestTiming = requestEvents.get(last?.requestId);
  return {
    speed: number(last?.tokensPerSecond),
    firstTokenMs: number(last?.timeToFirstTokenMs ?? latestTiming?.timeToFirstTokenMs),
    input: number(last?.usage?.inputTokens),
    output: number(last?.usage?.outputTokens),
    thinking: number(last?.usage?.reasoningTokens),
    read: number(last?.usage?.cachedInputTokens),
    write: number(last?.usage?.cachedWriteInputTokens),
    // A request index alone cannot identify a product turn.
    turns: rounds.flatMap(round => {
      const key = round.productTurnId ?? round.turnId ?? requestEvents.get(round.requestId)?.queryId;
      const usage = round.usage;
      return typeof key === 'string' && usage ? [{ key, thinking: number(usage.reasoningTokens),
        input: number(usage.inputTokens), read: number(usage.cachedInputTokens), speed: number(round.tokensPerSecond) }] : [];
    }),
  };
}

module.exports = { addNumbers, estimateTokens, modelName, nativeRounds, number, quotaSummary, rowSummary,
  subagentSummary, usageSummary };
