import assert from 'node:assert/strict';
import test from 'node:test';

import { formatContextReport, isContextCommand, runContextCommand } from '../src/channels/shared/context-command.mjs';

function state(sessionId = 'session-one') {
  return { sessionFor: () => sessionId };
}

function harnessReturning(snapshot) {
  return { getSessionContext: async () => snapshot };
}

const FULL_SNAPSHOT = {
  sessionId: 'fcdf45e8-487b-7b8c-f460-e45c768a2f9d',
  live: true,
  projectionKind: 'sequenced',
  pressure: { pressureTokens: 100638, contextWindow: 1000000, surfaceTokens: 68282 },
  breakdown: { systemTokens: 1568, toolsTokens: 8605, messageTokens: 66875 },
  usage: { inputTokens: 333506, outputTokens: 30593, cacheReadTokens: 4574720, cacheWriteTokens: 0 },
};

test('context command is recognised only with its exact name', () => {
  assert.equal(isContextCommand('/context'), true);
  assert.equal(isContextCommand('  /context  '), true);
  assert.equal(isContextCommand('/contextnow'), false);
  assert.equal(isContextCommand('/contextual'), false);
  assert.equal(isContextCommand('context'), false);
});

test('a non-command message is left to other handlers', async () => {
  assert.equal(await runContextCommand('hello', {}, state(), 'direct:one'), null);
});

test('an argument is rejected with the usage line', async () => {
  const result = await runContextCommand('/context 5', harnessReturning(FULL_SNAPSHOT), state(), 'direct:one');
  assert.match(result.message, /用法/);
});

test('an unbound chat is told how to bind a session', async () => {
  const result = await runContextCommand('/context', harnessReturning(FULL_SNAPSHOT), state(null), 'direct:one');
  assert.match(result.message, /尚未绑定会话/);
});

test('images and files are refused because the command is text-only', async () => {
  const result = await runContextCommand('/context', harnessReturning(FULL_SNAPSHOT), state(), 'direct:one', {
    hasImages: true,
  });
  assert.match(result.message, /仅支持文字命令/);
});

test('a session missing from the Host is reported instead of crashing', async () => {
  const result = await runContextCommand('/context', harnessReturning(null), state(), 'direct:one');
  assert.match(result.message, /已不存在/);
});

test('a binding change during the read is reported', async () => {
  let reads = 0;
  const racing = {
    getSessionContext: async () => {
      reads += 1;
      return FULL_SNAPSHOT;
    },
  };
  const changingState = { sessionFor: () => (reads === 0 ? 'session-one' : 'session-two') };
  const result = await runContextCommand('/context', racing, changingState, 'direct:one');
  assert.match(result.message, /已发生变化/);
});

test('a transport failure degrades to a retry message', async () => {
  const failing = {
    getSessionContext: async () => {
      throw new Error('boom');
    },
  };
  const result = await runContextCommand('/context', failing, state(), 'direct:one');
  assert.match(result.message, /暂时无法读取/);
});

test('a cancelled read says so', async () => {
  const aborted = {
    getSessionContext: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  };
  const result = await runContextCommand('/context', aborted, state(), 'direct:one');
  assert.match(result.message, /已取消/);
});

test('provider-reported pressure renders the exact ratio and breakdown', async () => {
  const result = await runContextCommand('/context', harnessReturning(FULL_SNAPSHOT), state(), 'direct:one');
  const text = result.message;
  assert.match(text, /100,638 \/ 1,000,000/);
  assert.match(text, /10%/);
  assert.match(text, /构成（估算）/);
  assert.match(text, /累计用量/);
  // Cache hits are summed with uncached input, then reported with a hit rate.
  assert.match(text, /4,908,226/);
  assert.match(text, /93%/);
  assert.equal(result.handled, true);
});

test('a provider that never reports usage falls back to the heuristic estimate', async () => {
  const result = runContextCommand('/context', harnessReturning({
    sessionId: 'session-one',
    live: false,
    projectionKind: 'sequenced',
    pressure: { contextWindow: 1000000, surfaceTokens: 785 },
    breakdown: { systemTokens: 645, toolsTokens: 4899, messageTokens: 140 },
    usage: null,
  }), state(), 'direct:one');
  const text = (await result).message;
  assert.match(text, /模型尚未上报用量/);
  assert.match(text, /5,684/);
  assert.match(text, /占窗口/);
});

test('an empty session says there is nothing to measure yet', () => {
  const result = formatContextReport({
    sessionId: 'session-empty',
    live: false,
    projectionKind: 'cached',
    pressure: { surfaceTokens: 0 },
    breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
    usage: null,
  });
  assert.match(result.message, /还没有可统计的上下文/);
});

test('a cached projection is disclosed as a snapshot', () => {
  const result = formatContextReport({ ...FULL_SNAPSHOT, live: false, projectionKind: 'cached' });
  assert.match(result.message, /没有活跃 Agent/);
  assert.doesNotMatch(formatContextReport(FULL_SNAPSHOT).message, /没有活跃 Agent/);
});
