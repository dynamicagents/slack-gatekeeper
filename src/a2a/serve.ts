import {
  AGENT_CARD_PATH,
  A2A_VERSION_HEADER,
  AgentCard,
  Extensions,
  HTTP_EXTENSION_HEADER
} from "@a2a-js/sdk";
import {
  JsonRpcTransportHandler,
  defaultServerCallContextBuilder,
  validateVersion,
  type A2ARequestHandler,
  type RequestHeaders,
  type ServerCallContext
} from "@a2a-js/sdk/server";

/**
 * Workers/Durable-Object fetch bridge for an A2A server. The official SDK only
 * ships Express and gRPC transport bindings; this is the equivalent for `fetch`
 * (Request → Response), delegating to the SDK's transport-agnostic
 * `JsonRpcTransportHandler` + the agent's request handler.
 *
 * - `GET …/.well-known/agent-card.json` → the AgentCard (discovery).
 * - `POST`                              → JSON-RPC (`SendMessage`, etc.).
 *
 * Streaming (`SendStreamingMessage`) is intentionally unsupported — agents
 * advertise `capabilities.streaming: false`, so a single reply is returned.
 *
 * Returns the JSON-RPC `Response` and, for a `SendMessage` that produced a Task,
 * that Task's `id` — the caller (the agent DO) uses it to key the `ctx.waitUntil`
 * liveness barrier for the accepted turn.
 */
export async function serveA2A(
  request: Request,
  handler: A2ARequestHandler
): Promise<{ response: Response; taskId?: string }> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname.endsWith(AGENT_CARD_PATH)) {
    // Serve the protobuf-JSON encoding, not the in-memory proto object: the
    // wire form omits proto defaults (empty maps/arrays) that a v1.0 client's
    // card resolver would otherwise have to tolerate, and it is the exact
    // document an agent-card signature is computed over.
    return {
      response: Response.json(AgentCard.toJSON(await handler.getAgentCard()))
    };
  }

  if (request.method !== "POST") {
    return { response: new Response("not found", { status: 404 }) };
  }

  const body = await request.json<string | Record<string, unknown>>();
  const context = buildCallContext(request);

  // v1.0 negotiates the protocol version per request via the `A2A-Version`
  // header, and the SDK leaves enforcement to the transport binding (the
  // Express handlers do it; this bridge is the equivalent seam). An absent
  // header is treated as `0.3` by the SDK, which our v1.0-only cards do not
  // advertise — so a legacy caller is rejected here rather than silently
  // mis-served.
  try {
    validateVersion(
      context.requestedVersion,
      await handler.getAgentCard(),
      "JSONRPC"
    );
  } catch (err) {
    return { response: jsonRpcErrorResponse(body, err) };
  }

  const rpc = new JsonRpcTransportHandler(handler);
  const result = await rpc.handle(body, context);

  // Async generators are only returned for streaming methods, which we don't
  // advertise; reject rather than half-consume a stream.
  if (Symbol.asyncIterator in result) {
    return {
      response: new Response("streaming not supported", { status: 501 })
    };
  }

  return {
    response: Response.json(result, { headers: extensionHeaders(context) }),
    taskId: acceptedTaskId(result)
  };
}

/**
 * Build the per-call {@link ServerCallContext} the v1.0 request handler now
 * requires, from the inbound `fetch` Request. The default builder stashes the
 * raw headers in the context's state bag, so an executor can reach them the
 * same way it would under the Express binding.
 *
 * The caller is deliberately left unauthenticated: these DOs are reached over
 * `stub.fetch` from the gatekeeper itself, so the trust boundary is the Worker,
 * not this handler. `tenant` is likewise unset — one DO instance *is* the
 * tenant (`admin:{wsId}` / `onboarding:{userId}`), keyed by the caller.
 */
function buildCallContext(request: Request): ServerCallContext {
  const headers: RequestHeaders = {};
  for (const [name, value] of request.headers) headers[name] = value;

  return defaultServerCallContextBuilder({
    extensions: Extensions.parseServiceParameter(
      request.headers.get(HTTP_EXTENSION_HEADER) ?? undefined
    ),
    user: undefined,
    headers,
    requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined
  });
}

/** Echo back the extensions the handler actually activated (spec §14.2.2). */
function extensionHeaders(context: ServerCallContext): HeadersInit {
  const activated = context.activatedExtensions;
  if (!activated?.length) return {};
  return { [HTTP_EXTENSION_HEADER]: Extensions.toServiceParameter(activated) };
}

/**
 * A JSON-RPC error envelope for a failure raised before the SDK handler ran,
 * echoing the request's `id` so a conformant client can correlate it. Errors
 * are transported at HTTP 200 per JSON-RPC 2.0, matching what the SDK handler
 * returns for the failures it maps itself.
 *
 * The mapper is the transport handler's own static rather than the equivalent
 * `toJsonRpcError` from `@a2a-js/sdk/errors`: those are separately bundled
 * entry points that each carry their own copy of the error classes, so only
 * the server bundle's mapper recognizes an error the server bundle threw —
 * the other one would flatten every semantic error to a generic internal error.
 */
function jsonRpcErrorResponse(body: unknown, err: unknown): Response {
  const id = (body as { id?: string | number | null } | null)?.id ?? null;
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: JsonRpcTransportHandler.mapToJSONRPCError(err)
  });
}

/**
 * The accepted Task's id from a JSON-RPC success envelope, else undefined
 * (errors, message-shaped results, card reads). v1.0 returns the protobuf-JSON
 * of `SendMessageResponse`, whose payload oneof appears as a single `task` or
 * `message` key rather than v0.3's inline `kind` discriminator.
 */
function acceptedTaskId(rpcResult: unknown): string | undefined {
  const result = (rpcResult as { result?: unknown } | null)?.result;
  if (!result || typeof result !== "object") return undefined;
  const task = (result as { task?: unknown }).task;
  if (!task || typeof task !== "object") return undefined;
  const id = (task as { id?: unknown }).id;
  if (typeof id === "string" && id.trim().length > 0) return id;
  return undefined;
}
