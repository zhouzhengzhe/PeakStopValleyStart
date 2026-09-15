/**
 * Self-check for the badge action endpoint.
 *
 * Run with `node test/badge-api.test.mjs`.
 *
 * The endpoint is a browser-reachable surface, so its rejection cases matter as
 * much as its happy path: a closed action vocabulary is what keeps a malformed or
 * hostile request from reaching the command handler. Those cases are pure and
 * cheap to assert, which is why the parsing was separated from the transport.
 *
 * @module peak-valley-brake/test/badge-api
 */

import assert from 'node:assert/strict';

import {
  BADGE_ACTIONS,
  BADGE_ACTION_PATH,
  badgeActionResponse,
  createBadgeRouteHandler,
  parseBadgeAction,
  readJsonBody,
} from '../lib/badge-api.js';

const results = { passed: 0, failed: 0 };

/**
 * Run one named async case and record its outcome.
 * @param {string} caseName - the case name.
 * @param {() => Promise<void> | void} body - case body.
 * @returns {Promise<void>} resolution after the case settles.
 */
async function test(caseName, body) {
  try {
    await body();
    results.passed += 1;
    process.stdout.write(`  ok   ${caseName}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${caseName}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * Build a POST request carrying a body.
 * @param {string} body - raw body text.
 * @returns {Request} the request.
 */
function post(body) {
  return new Request(`http://127.0.0.1:43129${BADGE_ACTION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/**
 * Build a route handler whose collaborators record what they received.
 * @param {object} [options] - overrides.
 * @param {object} [options.agent] - the agent `agentForSession` should return.
 * @param {(agent: object, subcommand: string) => Promise<object>} [options.runCommand] - command runner.
 * @param {string} [options.resolved] - what `resolveSessionId` returns.
 * @param {object} [options.state] - what `stateForSession` returns.
 * @returns {{handler: Function, calls: object[]}} the handler and its call log.
 */
function host(options = {}) {
  const calls = [];
  const handler = createBadgeRouteHandler({
    agentForSession: (sessionId) => (sessionId === 'session-live' ? (options.agent ?? { id: sessionId }) : undefined),
    resolveSessionId: () => ('resolved' in options ? options.resolved : 'session-live'),
    stateForSession: () => options.state,
    runCommand:
      options.runCommand ??
      ((agent, subcommand) => {
        calls.push({ agent, subcommand });
        return Promise.resolve({ kind: 'success', text: `ran ${subcommand}` });
      }),
  });
  return { handler, calls };
}

process.stdout.write('peak-valley-brake badge action endpoint\n\n');

process.stdout.write('the claimed path\n');

await test('the path sits under the authenticated /api prefix', () => {
  // Anything outside /api would bypass the harness's browser authentication and
  // Host/Origin fence, and anything unclaimed under /api returns 404 instead of
  // falling through to another owner.
  assert.match(BADGE_ACTION_PATH, /^\/api\//u);
});

await test('the action vocabulary is closed and maps onto real subcommands', () => {
  assert.deepEqual(Object.keys(BADGE_ACTIONS).sort(), ['cancel', 'now', 'poll', 'status', 'window']);
  for (const [action, subcommand] of Object.entries(BADGE_ACTIONS)) {
    if (action === 'poll') {
      // The one read-only action. It exists because the client half of this
      // harness provides no projection service, so the browser cannot read the
      // published state on its own.
      assert.equal(subcommand, null);
      continue;
    }
    assert.ok(['status', 'now', 'window', 'cancel'].includes(subcommand));
  }
});

process.stdout.write('\nrequest validation\n');

await test('every advertised action parses to its subcommand', () => {
  for (const [action, subcommand] of Object.entries(BADGE_ACTIONS)) {
    const parsed = parseBadgeAction({ action, sessionId: 'session-live' });
    assert.equal(parsed.ok, true, `${action} must be accepted`);
    assert.equal(parsed.subcommand, subcommand);
  }
});

await test('an absent session id is accepted, because the host resolves it', () => {
  // The badge cannot know a session on its first poll: the client half provides
  // no session registry. Refusing that request would mean the badge could never
  // take its first reading.
  for (const sessionId of [undefined, null, '', '   ']) {
    const parsed = parseBadgeAction({ action: 'poll', sessionId });
    assert.equal(parsed.ok, true, `${JSON.stringify(sessionId)} must be accepted`);
    assert.equal(parsed.sessionId, undefined);
  }
});

await test('a session id of the wrong type is refused', () => {
  for (const sessionId of [42, {}, ['session-live'], true]) {
    const parsed = parseBadgeAction({ action: 'now', sessionId });
    assert.equal(parsed.ok, false, `${JSON.stringify(sessionId)} must be refused`);
    assert.match(parsed.error, /sessionId must be a string/u);
  }
});

await test('an unknown action is refused rather than forwarded', () => {
  const parsed = parseBadgeAction({ action: 'delete-everything', sessionId: 'session-live' });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 400);
  assert.match(parsed.error, /action must be one of/u);
});

await test('a non-object body is refused', () => {
  for (const body of [null, 'text', 42, ['now']]) {
    assert.equal(parseBadgeAction(body).ok, false, `${JSON.stringify(body)} must be refused`);
  }
});

await test('the session id is trimmed before use', () => {
  const parsed = parseBadgeAction({ action: 'status', sessionId: '  session-live  ' });
  assert.equal(parsed.sessionId, 'session-live');
});

process.stdout.write('\nbody reading\n');

await test('a valid JSON body is decoded', async () => {
  const read = await readJsonBody(post('{"action":"now","sessionId":"session-live"}'));
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, { action: 'now', sessionId: 'session-live' });
});

await test('an empty body is refused', async () => {
  const read = await readJsonBody(post(''));
  assert.equal(read.ok, false);
  assert.equal(read.status, 400);
});

await test('malformed JSON is refused without throwing', async () => {
  const read = await readJsonBody(post('{not json'));
  assert.equal(read.ok, false);
  assert.match(read.error, /not valid JSON/u);
});

await test('an oversized body is refused', async () => {
  const read = await readJsonBody(post(`{"action":"now","sessionId":"${'x'.repeat(9000)}"}`));
  assert.equal(read.ok, false);
  assert.equal(read.status, 413);
});

process.stdout.write('\nresponses\n');

await test('a success returns 200 carrying the handler text unchanged', () => {
  const response = badgeActionResponse({ kind: 'success', text: 'released' });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.text, 'released', 'a button must show what the command line prints');
});

await test('a command error returns 409 carrying its text', () => {
  const response = badgeActionResponse({ kind: 'error', text: 'override is disabled' });
  assert.equal(response.status, 409);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.text, 'override is disabled');
});

process.stdout.write('\nthe route\n');

await test('an accepted action runs the mapped subcommand for the named session', async () => {
  const { handler, calls } = host({ state: { engaged: true, heldCount: 2 } });
  const response = await handler(post('{"action":"window","sessionId":"session-live"}'));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subcommand, 'window');
  assert.equal(calls[0].agent.id, 'session-live');
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: 'success',
    text: 'ran window',
    sessionId: 'session-live',
    state: { engaged: true, heldCount: 2 },
  });
});

await test('an action with no session id runs against the session the host resolves', async () => {
  // What the badge's very first request looks like.
  const { handler, calls } = host();
  const response = await handler(post('{"action":"status"}'));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent.id, 'session-live');
  assert.equal((await response.json()).sessionId, 'session-live');
});

await test('every answer carries the state, so a button needs no second request', async () => {
  const { handler } = host({ state: { engaged: false, heldCount: 0 } });
  for (const action of ['poll', 'status', 'now', 'window', 'cancel']) {
    const body = await (await handler(post(JSON.stringify({ action, sessionId: 'session-live' })))).json();
    assert.deepEqual(body.state, { engaged: false, heldCount: 0 }, `${action} must report the state`);
  }
});

await test('poll answers with state and runs no command', async () => {
  const { handler, calls } = host({ state: { engaged: true, heldCount: 3 } });
  const response = await handler(post('{"action":"poll"}'));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 0, 'poll must not reach the command handler');
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: 'state',
    text: '',
    sessionId: 'session-live',
    state: { engaged: true, heldCount: 3 },
  });
});

await test('a composition tracking no session says so instead of pretending', async () => {
  // Nothing has been braked yet in this process, so there is no session to
  // describe. The badge shows its idle pose and asks again on the next poll.
  const { handler, calls } = host({ resolved: undefined });
  const response = await handler(post('{"action":"poll"}'));
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
  assert.match((await response.json()).error, /no session is currently tracked/u);
});

await test('a session with no published state still answers, with a null state', async () => {
  const { handler } = host({ state: undefined });
  const body = await (await handler(post('{"action":"poll","sessionId":"session-live"}'))).json();
  assert.equal(body.ok, true);
  assert.equal(body.state, null, 'a null state is a fact the badge can draw; a 404 would be a dead badge');
});

await test('a session with no live agent is reported as such', async () => {
  const { handler, calls } = host();
  const response = await handler(post('{"action":"now","sessionId":"session-gone"}'));
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0, 'the command must not run for an unknown session');
  assert.match((await response.json()).error, /no live agent/u);
});

await test('a rejected body never reaches the command runner', async () => {
  const { handler, calls } = host();
  for (const body of ['', '{bad', '{"action":"nope","sessionId":"session-live"}', '{"action":"now","sessionId":42}']) {
    const response = await handler(post(body));
    assert.ok(response.status >= 400, `body ${JSON.stringify(body)} must be rejected`);
  }
  assert.equal(calls.length, 0, 'no rejected request may run a command');
});

await test('a throwing command runner becomes a 500 rather than a hang', async () => {
  const { handler } = host({
    runCommand: () => Promise.reject(new Error('handler exploded')),
  });
  const response = await handler(post('{"action":"now","sessionId":"session-live"}'));
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /handler exploded/u);
});

await test('every response forbids caching, so a badge cannot show stale state', async () => {
  const { handler } = host();
  const response = await handler(post('{"action":"status","sessionId":"session-live"}'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /application\/json/u);
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
