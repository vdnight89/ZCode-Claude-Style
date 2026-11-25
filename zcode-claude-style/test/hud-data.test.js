'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { nativeRounds, quotaSummary, rowSummary, subagentSummary, usageSummary } = require('../runtime/hud-data');

test('restored sessions use measured cumulative input when the legacy counter is zero', () => {
  const actual = usageSummary({
    contextWindow: { usedTokens: 790, maxTokens: 1000, cache: { hitRate: 0.9, totalInputTokens: 4000 } },
    cumulative: { inputTokens: 600, outputTokens: 0 },
  }, { breakdown: [{ source: 'messages', chars: 600 }, { source: 'system_prompt', chars: 100 }] });
  assert.equal(actual.available, 210);
  assert.equal(actual.cache.hit, 0.9);
  assert.equal(actual.cumulative.input, 4000);
  assert.equal(actual.cumulative.inputFromCache, true);
  assert.equal(actual.cumulative.output, null);
  assert.equal(actual.breakdown[0].fraction, 600 / 700);
});

test('turns and tool results use product turn IDs and deduplicate tool-call updates', () => {
  const rows = [
    { kind: 'turnHeader', rowId: 1, turnId: 'actual', productTurnId: 'turn', historyRoundCount: 3,
      outputTokens: 0, modelDurationMs: 0 },
    { kind: 'userInput', rowId: 2, turnId: 'actual', entityId: 'query', text: '查看这个项目' },
    { kind: 'assistantText', rowId: 3, turnId: 'actual', text: '这是回复' },
    { kind: 'reasoning', rowId: 4, turnId: 'actual', text: '思考过程' },
    { kind: 'toolCall', rowId: 5, turnId: 'actual', toolCallId: 'tool-1', toolName: 'Read' },
    { kind: 'toolCall', rowId: 6, turnId: 'actual', toolCallId: 'tool-1', toolName: 'Read',
      output: { text: '测试输出', truncated: true } },
  ];
  const actual = rowSummary(rows, 20);
  assert.equal(actual.turns.length, 1);
  assert.equal(actual.rawToProduct.get('query'), 'turn');
  assert.equal(actual.turns[0].requests, 3);
  assert.equal(actual.turns[0].output, 3);
  assert.equal(actual.turns[0].outputEstimated, true);
  assert.equal(actual.turns[0].speed, null);
  assert.equal(actual.turns[0].context, null);
  assert.equal(actual.toolCalls, 1);
  assert.deepEqual(actual.ranking, [{ name: 'Read', count: 1, tokens: 3, missing: 0, clipped: 1 }]);
  assert.equal(actual.totalRows, 20);
});

test('provider quota only uses the selected entitlement and remaining credit', () => {
  const snapshot = { authenticated: true, quota: { limits: [{ unit: 3, number: 5, usage: 100, remaining: 25 }] } };
  const entitlements = [{ providerId: 'provider-a', snapshot }];
  assert.deepEqual(quotaSummary({ selectedProviderId: 'provider-b', entitlements }), []);
  assert.equal(quotaSummary({ selectedProviderId: 'provider-a', entitlements })[0].fraction, 0.25);
  snapshot.quota.limits.push({ unit: 6, number: 1, usage: 60000, remaining: 18122, percentage: 69 });
  const weekly = quotaSummary({ selectedProviderId: 'provider-a', entitlements })[1];
  assert.equal(weekly.name, '每周');
  assert.equal(weekly.displayPercent, 31);
});

test('debug rows only join a turn when a native turn ID exists', () => {
  const actual = nativeRounds({ rounds: [
    { requestIndex: 1, usage: { inputTokens: 9, reasoningTokens: 2 } },
    { requestId: 'native-3', usage: { inputTokens: 2 } },
    { turnId: 'turn', tokensPerSecond: 24, timeToFirstTokenMs: 100,
      usage: { inputTokens: 6, cachedInputTokens: 3, reasoningTokens: 1 } },
  ], networkEntries: [{ requestId: 'native-3', queryId: 'query', statusType: 'model_request_completed' }] });
  assert.equal(actual.speed, 24);
  assert.equal(actual.firstTokenMs, 100);
  assert.deepEqual(actual.turns, [{ key: 'query', thinking: null, input: 2, read: null, speed: null },
    { key: 'turn', thinking: 1, input: 6, read: 3, speed: 24 }]);
});

test('child usage comes from the child record when present and leaves missing totals blank', () => {
  const state = { childSessionIds: ['a', 'b'], running: [{ childSessionId: 'b', label: 'Search' }],
    ended: { total: 1, items: [{ childSessionId: 'a', title: 'Explore' }] } };
  const data = subagentSummary(state, new Map([['a', { requestCount: 2, inputTokens: 20, outputTokens: 5 }]]));
  assert.equal(data.known, 2);
  assert.equal(data.items[0].total, 25);
  assert.equal(data.items[0].requests, 2);
  assert.equal(data.items[1].total, null);
  assert.equal(data.items[1].running, true);
});
