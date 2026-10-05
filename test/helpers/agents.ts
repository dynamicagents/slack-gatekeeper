import { vi } from "vitest";
import { exports } from "cloudflare:workers";

/**
 * Driving the built-in agents end to end.
 *
 * A built-in is a core tenant on this Worker, and core talks to the gatekeeper
 * over HTTP like any remote agent would: its edge fetches the gatekeeper's
 * JWKS to verify a dispatch, and its task host POSTs every reply to
 * `/a2a/notifications`. In production both reach this same Worker at its
 * public URL; here {@link stubOutbound} sends them there, through its own
 * default export, and
 * hands everything else to a Slack stub.
 *
 * The model is the one thing faked, in `test/worker.ts`.
 */

export { SCRIPTED_REPLY } from "../worker";

/**
 * Stub global fetch: a request to `origin` — the gatekeeper's own `public_url`
 * in the spec — goes to this Worker; anything else is a Slack Web API call,
 * answered by `slack(method, body)` the way `stubSlack` answers it. Call
 * `vi.unstubAllGlobals()` in `afterEach` to restore.
 */
export function stubOutbound(
  origin: string,
  slack: (method: string, body: URLSearchParams) => unknown
): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === origin) return exports.default.fetch(request);
      const method = url.pathname.split("/").pop() ?? "";
      const form = new TextDecoder().decode(await request.arrayBuffer());
      const payload = slack(method, new URLSearchParams(form));
      return Response.json(payload);
    }
  );
}

/**
 * Wait until `done()` holds, for what a built-in delivers after the workflow
 * that dispatched it has finished: its reply travels through core's task
 * workflow and push callback, so the dispatching workflow reaching `complete`
 * says nothing about it having landed.
 */
export async function eventually(
  done: () => boolean | Promise<boolean>,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("eventually: timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
