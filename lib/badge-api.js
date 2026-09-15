/**
 * The badge's action endpoint: a browser button reaching the same code a slash
 * command reaches.
 *
 * Why an HTTP route rather than a model tool: the brake refuses a step before the
 * model runs, so anything the model could call is unreachable exactly when the
 * badge is needed. A route is reachable from the moment the page loads.
 *
 * Why it must live under `/api`: measured, not assumed. The harness gives the
 * `/api` prefix to exactly one owner, which performs browser authentication and
 * Host/Origin validation before dispatching to the exact paths that feature
 * plugins register. A route registered anywhere else would bypass that fence, and
 * an unclaimed path under `/api` returns 404 rather than falling through.
 *
 * Every action maps onto an existing `/peak-valley` subcommand, and the route
 * calls the same handler the command does. A button therefore cannot drift from
 * the command line, because there is one implementation of each operation.
 *
 * @module peak-valley-brake/badge-api
 */

/** The exact path this plugin claims under the authenticated `/api` prefix. */
export const BADGE_ACTION_PATH = '/api/peak-valley-brake.action';

/**
 * Actions a button may request, mapped to the subcommand they run.
 *
 * A closed map rather than free text: the endpoint accepts a fixed vocabulary, so
 * a malformed or hostile request cannot reach the command handler with arbitrary
 * input.
 *
 * `poll` is the one read-only action and maps to no subcommand: it exists because
 * the browser cannot read the published state on its own. The client half of this
 * harness provides `connection`, `locale`, `theme` and a few others, but no
 * session registry and no projection registry, so a client plugin that declared
 * those names would wait forever for a service that never arrives and would never
 * mount. The state therefore travels over this route instead, which the host can
 * answer because the host owns both services.
 */
export const BADGE_ACTIONS = Object.freeze({
  poll: null,
  status: 'status',
  now: 'now',
  window: 'window',
  cancel: 'cancel',
});

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Parse and validate one badge action request.
 *
 * Pure, so the whole vocabulary and every rejection can be tested without an HTTP
 * server: this is the part of the endpoint that decides what is allowed.
 *
 * `sessionId` is optional on purpose. The badge learns which session it is
 * showing from the poll response, so it normally sends one back; when it cannot
 * — the very first poll of a fresh page — the host resolves the session itself
 * rather than rejecting the request, because a badge that can never take its
 * first reading is worse than one the host has to orient.
 *
 * @param {unknown} body - the decoded JSON body.
 * @returns {{ok: true, action: string, subcommand: string|null, sessionId: string|undefined}
 *   | {ok: false, status: number, error: string}} the validated request or a rejection.
 */
export function parseBadgeAction(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }

  const { action, sessionId } = body;
  if (typeof action !== 'string' || !Object.hasOwn(BADGE_ACTIONS, action)) {
    return {
      ok: false,
      status: 400,
      error: `action must be one of ${Object.keys(BADGE_ACTIONS).join(', ')}`,
    };
  }
  if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
    // A wrong type is a client bug worth reporting; an absent one is not.
    return { ok: false, status: 400, error: 'sessionId must be a string when present' };
  }

  const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
  return {
    ok: true,
    action,
    subcommand: BADGE_ACTIONS[action],
    sessionId: trimmed === '' ? undefined : trimmed,
  };
}

/**
 * Build the JSON response body for a settled command.
 *
 * The handler's own text is passed through unchanged, so what a button shows and
 * what the command line prints are the same string — which is the point of
 * routing both through one handler.
 *
 * @param {{kind: string, text: string}} result - the command result.
 * @returns {{status: number, body: object}} the HTTP status and body.
 */
export function badgeActionResponse(result) {
  return {
    status: result.kind === 'error' ? 409 : 200,
    body: { ok: result.kind !== 'error', kind: result.kind, text: result.text },
  };
}

/**
 * Read the JSON body of a request, bounded.
 *
 * @param {Request} request - the incoming request.
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, status: number, error: string}>} the decoded body or a rejection.
 */
export async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: 'request body could not be read' };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'request body is too large' };
  }
  if (text.trim() === '') return { ok: false, status: 400, error: 'request body is empty' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'request body is not valid JSON' };
  }
}

/**
 * Create the route handler.
 *
 * Every response — including a failure — carries the resolved `sessionId` and the
 * current published `state`, so one round trip both performs the action and
 * refreshes the badge. The alternative, a separate refresh call after every
 * button, would double the traffic to show the same fact.
 *
 * @param {object} deps - the collaborators the route needs.
 * @param {(sessionId: string) => object|undefined} deps.agentForSession - resolve the live agent owning a session.
 * @param {(agent: object, subcommand: string) => Promise<{kind: string, text: string}>} deps.runCommand - the same handler the slash command uses.
 * @param {() => string|undefined} deps.resolveSessionId - the session to act on when the client names none.
 * @param {(sessionId: string) => object|undefined} deps.stateForSession - the last published state for a session.
 * @returns {(request: Request) => Promise<Response>} the fetch-shaped handler.
 */
export function createBadgeRouteHandler(deps) {
  return async function handle(request) {
    const decoded = await readJsonBody(request);
    if (!decoded.ok) {
      return json({ ok: false, error: decoded.error }, decoded.status);
    }

    const parsed = parseBadgeAction(decoded.value);
    if (!parsed.ok) {
      return json({ ok: false, error: parsed.error }, parsed.status);
    }

    const sessionId = parsed.sessionId ?? deps.resolveSessionId();
    if (typeof sessionId !== 'string' || sessionId === '') {
      // Nothing has been braked yet in this process, so there is no session to
      // describe. The badge shows its idle pose and asks again on the next poll.
      return json({ ok: false, error: 'no session is currently tracked by the brake' }, 404);
    }

    const agent = deps.agentForSession(sessionId);
    if (agent === undefined) {
      // A stale badge in a closed tab is the ordinary cause, so this is a client
      // error rather than a server fault, and the message says which session.
      return json({ ok: false, error: `no live agent for session ${sessionId}` }, 404);
    }

    const state = deps.stateForSession(sessionId) ?? null;

    if (parsed.subcommand === null) {
      return json({ ok: true, kind: 'state', text: '', sessionId, state }, 200);
    }

    try {
      const result = await deps.runCommand(agent, parsed.subcommand);
      const response = badgeActionResponse(result);
      // Re-read after the command: a release or an override publishes new state,
      // and the badge must not need a second request to see it.
      return json(
        { ...response.body, sessionId, state: deps.stateForSession(sessionId) ?? null },
        response.status,
      );
    } catch (error) {
      // The command handler is already fail-soft; reaching here means something
      // outside it broke, and the badge should say so rather than hang.
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          sessionId,
          state,
        },
        500,
      );
    }
  };
}

/**
 * Build a JSON response with headers that keep a badge from caching stale state.
 * @param {object} body - the JSON body.
 * @param {number} status - the HTTP status.
 * @returns {Response} the response.
 */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
