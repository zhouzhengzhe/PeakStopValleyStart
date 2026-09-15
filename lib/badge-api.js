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
 */
export const BADGE_ACTIONS = Object.freeze({
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
 * @param {unknown} body - the decoded JSON body.
 * @returns {{ok: true, action: string, subcommand: string, sessionId: string}
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
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, status: 400, error: 'sessionId must be a non-empty string' };
  }

  return { ok: true, action, subcommand: BADGE_ACTIONS[action], sessionId: sessionId.trim() };
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
 * @param {object} deps - the collaborators the route needs.
 * @param {(sessionId: string) => object|undefined} deps.agentForSession - resolve the live agent owning a session.
 * @param {(agent: object, subcommand: string) => Promise<{kind: string, text: string}>} deps.runCommand - the same handler the slash command uses.
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

    const agent = deps.agentForSession(parsed.sessionId);
    if (agent === undefined) {
      // A stale badge in a closed tab is the ordinary cause, so this is a client
      // error rather than a server fault, and the message says which session.
      return json({ ok: false, error: `no live agent for session ${parsed.sessionId}` }, 404);
    }

    try {
      const result = await deps.runCommand(agent, parsed.subcommand);
      const response = badgeActionResponse(result);
      return json(response.body, response.status);
    } catch (error) {
      // The command handler is already fail-soft; reaching here means something
      // outside it broke, and the badge should say so rather than hang.
      return json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
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
