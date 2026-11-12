import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookPayload, SESSION_CONTEXT } from '../plugins/vizpane/lib/payload.mjs';

test('claude stop payload', () => {
  const r = parseHookPayload('claude', {
    hook_event_name: 'Stop', session_id: 's-1', cwd: '/p', stop_hook_active: false,
    last_assistant_message: 'hello',
  });
  assert.deepEqual(r, { agent: 'claude', session: 's-1', cwd: '/p', markdown: 'hello' });
});
test('codex stop payload', () => {
  const r = parseHookPayload('codex', {
    hook_event_name: 'Stop', session_id: 'c-1', turn_id: 't', cwd: '/q', last_assistant_message: 'x',
  });
  assert.deepEqual(r, { agent: 'codex', session: 'c-1', cwd: '/q', markdown: 'x' });
});
test('missing fields are tolerated', () => {
  const r = parseHookPayload('claude', { last_assistant_message: 'x' });
  assert.deepEqual(r, { agent: 'claude', session: 'unknown', cwd: '', markdown: 'x' });
});
test('missing or non-string message gives null', () => {
  assert.equal(parseHookPayload('claude', {}), null);
  assert.equal(parseHookPayload('claude', { last_assistant_message: 5 }), null);
  assert.equal(parseHookPayload('claude', { last_assistant_message: null }), null);
  assert.equal(parseHookPayload('claude', { last_assistant_message: '  ' }), null);
});
test('non-object payload gives null', () => {
  assert.equal(parseHookPayload('claude', null), null);
  assert.equal(parseHookPayload('claude', 'str'), null);
  assert.equal(parseHookPayload('claude', [1]), null);
});
// The context is injected into every Claude Code session, so it must carry the rules an agent
// needs even when it never opens the viz-style skill, and stay well under the 10,000-char cap.
test('SESSION_CONTEXT carries the diagram rules', () => {
  assert.ok(SESSION_CONTEXT.startsWith('vizpane is active'));
  for (const needle of ['```mermaid', 'viz-style skill', 'viz skill', '%% viz: stream', '%% viz: box', '%% viz: phase', 'subgraph', 'autonumber', '한국 엔지니어', 'backpressure']) {
    assert.ok(SESSION_CONTEXT.includes(needle), `missing: ${needle}`);
  }
  assert.ok(SESSION_CONTEXT.length < 2000, `too long: ${SESSION_CONTEXT.length}`);
});
