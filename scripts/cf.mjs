// Cloudflare API proxy. Reads credentials from .cf.env so the token never
// appears in the terminal, in shell history, or in an agent's context — the
// script holds it in memory, prints only the API response, and redacts the
// token from any output as a safety net.
//
// Subcommands (preferred — they build the request + a readable digest for you):
//   verify                     GET /accounts/{id}/tokens/verify
//   logs   [flags]             historical Worker logs (Observability telemetry)
//   wf     [name [instance]]   Workflows: list defs / list instances / one instance
//   ai     [flags | <logId>]   AI Gateway calls: digest, or one call's prompt + reply
//   fields [--worker <name>]   discover available log fields for a dataset
//   containers [name]          container apps: image, version, rollout progress
//
// logs flags:
//   --since <30m|2h|1d>   time window back from now (default 1h)
//   --worker <name>       filter by service/script name (server-side)
//   --level <error|warn|info|debug>   filter by level (server-side)
//   --grep <text>         keep events whose message contains <text>, case-
//                         insensitively (server-side, so it searches the whole
//                         window rather than the first page)
//   --limit <N>           max matching events (default 100, max 2000)
//   --json | --raw        full pretty JSON / verbatim body instead of the digest
//
// Raw passthrough (anything the subcommands don't cover):
//   [METHOD] <path> [-d <json|@file>] [-q <k=v>]... [--raw]
//   path starting with "/"  → verbatim under https://api.cloudflare.com/client/v4
//   otherwise               → account-relative: /accounts/{ACCOUNT_ID}/<path>
//
// Examples:
//   node scripts/cf.mjs verify
//   node scripts/cf.mjs logs --since 2h --level error
//   node scripts/cf.mjs logs --worker slack-gatekeeper --grep MessageWorkflow
//   node scripts/cf.mjs wf message-workflow
//   node scripts/cf.mjs wf message-workflow message-27to4pc4w7eo0psa59o
//   node scripts/cf.mjs ai --since 2h
//   node scripts/cf.mjs ai 01KY4PSY6T1HBA7A2V22NKCFZC
//   node scripts/cf.mjs GET workflows -q per_page=50
import fs from "node:fs";

const ENV_FILE = ".cf.env";
const BASE = "https://api.cloudflare.com/client/v4";
const DATASET = "cloudflare-workers";
// The telemetry API's hard ceiling on `limit`; above it the request 400s.
const MAX_LIMIT = 2000;
// AI Gateway has its own, much lower ceiling on `per_page` (verified: 50 is
// accepted, 51 gets "Number must be less than or equal to 50").
const AI_MAX_LIMIT = 50;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function die(msg) {
  console.error(`cf: ${msg}`);
  process.exit(1);
}

const USAGE = `cf.mjs — Cloudflare API proxy (credentials from ${ENV_FILE})

  verify                                 check the token
  logs [--since 1h] [--worker <name>]    historical Worker logs, as a digest
       [--level error] [--grep <text>]
       [--limit 100] [--json|--raw]
  wf                                     list workflow definitions
  wf <name>                              list recent instances of a workflow
  wf <name> <instanceId> [--json]        one instance, per-step pass/fail
  ai [--since 2h] [--model <m>]          AI Gateway calls, as a digest
     [--limit 20] [--json|--raw]
  ai <logId> [--full] [--max N]          one call: prompt + reply (bodies)
  fields [--worker <name>]               list available log fields
  containers [name] [--json|--raw]       container apps: which image is actually
                                         serving, and any rollout still moving
  [METHOD] <path> [-d <json|@file>]      raw passthrough (path is account-relative
       [-q <k=v>]... [--raw]             unless it starts with "/")`;

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  die(
    `could not read ${ENV_FILE}. Create it with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see .cf.env.example).`
  );
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token) die(`CLOUDFLARE_API_TOKEN missing in ${ENV_FILE}`);
if (!accountId) die(`CLOUDFLARE_ACCOUNT_ID missing in ${ENV_FILE}`);

// Never let the token leak into output, whatever the API echoes back. All
// stdout goes through out() so the guard covers every path.
const redact = (s) =>
  token ? String(s).split(token).join("***REDACTED***") : String(s);
const out = (s = "") => console.log(redact(s));
const acct = (p) => `/accounts/${accountId}/${p}`;
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);

function parseSince(s) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(s).trim());
  if (!m) die(`bad --since "${s}" (expected like 30m, 2h, 1d)`);
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return Number(m[1]) * unit;
}

// `--limit` for both `logs` and `ai`. Number.parseInt would quietly accept
// "2.5" and "20abc" as 2 and 20; Number() alone would pass NaN to the API and
// let it answer with a validation body nobody can read.
function parseLimit(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0)
    die(`bad --limit "${raw}" (expected a positive integer)`);
  return n;
}

// Pull known --flags out of an arg list; everything else is a positional.
function parseFlags(args, { bool = [], value = [] } = {}) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const key = a.replace(/^--?/, "");
    if (bool.includes(a)) flags[key] = true;
    else if (value.includes(a)) {
      const v = args[++i];
      if (v === undefined) die(`missing value for ${a}`);
      flags[key] = v;
    } else if (a.startsWith("-")) die(`unknown flag: ${a}`);
    else pos.push(a);
  }
  return { flags, pos };
}

async function request(method, apiPath, { query = [], body } = {}) {
  const url = new URL(BASE + apiPath);
  for (const [k, v] of query) url.searchParams.append(k, v);
  const headers = { Authorization: `Bearer ${token}` };
  const payload =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  console.error(`→ ${method} ${redact(url.pathname + url.search)}`);
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  console.error(`← ${res.status} ${res.statusText}`);
  return { res, text };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Print a body as pretty JSON (default) or verbatim (--raw). Returns the parsed
// JSON so callers can also render a digest from it.
function printBody(text, { raw = false } = {}) {
  if (raw) {
    out(text);
    return parseJson(text);
  }
  const json = parseJson(text);
  out(json ? JSON.stringify(json, null, 2) : text);
  return json;
}

// Exit on non-2xx responses and surface the API error body.
function ensureOk(res, text) {
  if (!res.ok) {
    printBody(text);
    process.exit(1);
  }
}

async function telemetryQuery({ from, to, filters, limit }) {
  const body = {
    queryId: "cf-cli",
    timeframe: { from, to },
    view: "events",
    limit,
    parameters: { datasets: [DATASET], ...(filters.length ? { filters } : {}) }
  };
  return request("POST", acct("workers/observability/telemetry/query"), {
    body
  });
}

async function cmdLogs(args) {
  const { flags } = parseFlags(args, {
    bool: ["--json", "--raw"],
    value: ["--since", "--worker", "--service", "--level", "--grep", "--limit"]
  });
  const sinceLabel = flags.since ?? "1h";
  const to = Date.now();
  const from = to - parseSince(sinceLabel);
  const limit = parseLimit(flags.limit, 100);
  // The API rejects anything above this with a validation body nobody can read.
  if (limit > MAX_LIMIT)
    die(`--limit ${limit} is above the API maximum of ${MAX_LIMIT}`);
  const worker = flags.worker ?? flags.service;

  const filters = [];
  if (flags.level)
    filters.push({
      key: "$metadata.level",
      operation: "eq",
      value: flags.level,
      type: "string"
    });
  if (worker)
    filters.push({
      key: "$metadata.service",
      operation: "eq",
      value: worker,
      type: "string"
    });
  /**
   * `--grep` is a **server-side** filter, and it has to be.
   *
   * It used to filter the returned page in this process, which was wrong twice
   * over. The obvious way: `limit` is applied by the API *before* anything here
   * runs, so `--grep foo` searched only the newest 100 events and reported "no
   * events matching" for anything older — a false negative that reads exactly
   * like a true one.
   *
   * The way that matters: raising `--limit` does not fix it. A query for the
   * last 72 hours with no filter and `limit: 2000` came back with 1107 events
   * spanning the whole window — and `[repo] afterCheckout failed`, timestamped
   * squarely inside that span, was **not among them**, while the same window
   * with this filter found it immediately. The page the API returns is not a
   * complete enumeration of the window even below the limit, so no amount of
   * client-side scanning can be trusted to find a rare line — which is the only
   * kind anybody greps for.
   *
   * `includes` is case-insensitive, matching what the client-side filter did,
   * and `$metadata.message` is byte-identical to the `source.message` that was
   * being tested before (verified across 1105 events, zero differing). So this
   * is the same question asked somewhere it can actually be answered.
   */
  if (flags.grep)
    filters.push({
      key: "$metadata.message",
      operation: "includes",
      value: String(flags.grep),
      type: "string"
    });

  const { res, text } = await telemetryQuery({ from, to, filters, limit });
  ensureOk(res, text);
  if (flags.json || flags.raw) {
    printBody(text, { raw: flags.raw });
    return;
  }

  const json = parseJson(text);
  const evs = json?.result?.events?.events ?? [];
  if (evs.length === 0) {
    out(
      `no events in last ${sinceLabel}${flags.grep ? ` matching "${flags.grep}"` : ""}`
    );
    return;
  }

  const byLevel = {};
  for (const e of evs)
    byLevel[e.source?.level ?? "?"] =
      (byLevel[e.source?.level ?? "?"] ?? 0) + 1;
  const levelStr = Object.entries(byLevel)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  const times = evs.map((e) => e.timestamp);
  out(`last ${sinceLabel} · ${evs.length} events · ${levelStr}`);
  out(`${hhmmss(Math.min(...times))} → ${hhmmss(Math.max(...times))}`);
  out("");
  for (const e of evs) {
    const lvl = (e.source?.level ?? "?").padEnd(5);
    const svc = (
      e["$metadata"]?.service ??
      e["$workers"]?.scriptName ??
      ""
    ).padEnd(24);
    const msg = (e.source?.message ?? "").replace(/\s+/g, " ").slice(0, 100);
    out(`${hhmmss(e.timestamp)}  ${lvl}  ${svc}  ${msg}`);
  }
  // Every filter is server-side now, so the page *is* the match set and this
  // counts what you were actually looking for.
  if (evs.length >= limit)
    out(
      `\n⚠ hit limit ${limit} — older matches are cut off; narrow --since or raise --limit (max ${MAX_LIMIT})`
    );
}

async function cmdWf(args) {
  const { flags, pos } = parseFlags(args, { bool: ["--json", "--raw"] });
  const [name, instance] = pos;

  if (!name) {
    const { res, text } = await request("GET", acct("workflows"));
    ensureOk(res, text);
    if (flags.json || flags.raw)
      return void printBody(text, { raw: flags.raw });
    const defs = parseJson(text)?.result ?? [];
    for (const w of defs)
      out(`- ${w.name}  | class: ${w.class_name}  | script: ${w.script_name}`);
    return;
  }

  if (!instance) {
    const { res, text } = await request(
      "GET",
      acct(`workflows/${name}/instances`)
    );
    ensureOk(res, text);
    if (flags.json || flags.raw)
      return void printBody(text, { raw: flags.raw });
    const arr = parseJson(text)?.result ?? [];
    if (!Array.isArray(arr) || arr.length === 0)
      return void out("no instances");
    for (const i of arr)
      out(
        `${i.id}  ${(i.status ?? "?").padEnd(10)}  ${i.created_on ?? i.created ?? ""}`
      );
    return;
  }

  const { res, text } = await request(
    "GET",
    acct(`workflows/${name}/instances/${instance}`)
  );
  ensureOk(res, text);
  if (flags.json || flags.raw) return void printBody(text, { raw: flags.raw });
  const r = parseJson(text)?.result;
  if (!r) return void printBody(text);
  out(
    `status: ${r.status}  success: ${r.success}  error: ${r.error ?? "null"}`
  );
  out(
    `queued ${r.queued ?? "?"} · start ${r.start ?? "?"} · end ${r.end ?? "?"}`
  );
  out(`steps (${r.step_count ?? r.steps?.length ?? 0}):`);
  for (const s of r.steps ?? []) {
    const errs = (s.attempts ?? []).filter((a) => a.error).map((a) => a.error);
    out(
      `  - ${(s.name ?? s.type ?? "?").padEnd(16)} ${s.success ? "ok" : "ERROR"}` +
        (errs.length ? ` ${JSON.stringify(errs)}` : "")
    );
  }
}

async function cmdFields(args) {
  const { flags } = parseFlags(args, {
    bool: ["--raw"],
    value: ["--since", "--worker", "--service"]
  });
  const to = Date.now();
  const from = to - parseSince(flags.since ?? "1h");
  const worker = flags.worker ?? flags.service;
  const filters = worker
    ? [
        {
          key: "$metadata.service",
          operation: "eq",
          value: worker,
          type: "string"
        }
      ]
    : [];
  const body = {
    queryId: "cf-cli-keys",
    timeframe: { from, to },
    parameters: { datasets: [DATASET], ...(filters.length ? { filters } : {}) }
  };
  const { res, text } = await request(
    "POST",
    acct("workers/observability/telemetry/keys"),
    {
      body
    }
  );
  ensureOk(res, text);
  if (flags.raw) return void printBody(text, { raw: true });
  const keys = parseJson(text)?.result ?? [];
  if (!Array.isArray(keys)) return void printBody(text);
  for (const k of keys)
    out(typeof k === "string" ? k : `${k.key ?? k.name}  (${k.type ?? "?"})`);
}

const AI_GW_DEFAULT = "default";

function truncate(s, max) {
  s = String(s ?? "");
  if (!Number.isFinite(max) || s.length <= max) return s;
  return `${s.slice(0, max)}\n  …[+${s.length - max} chars — use --full]`;
}

// Best-effort readable text for one chat message (string / multimodal / tool calls).
function messageText(msg) {
  if (typeof msg.content === "string" && msg.content.length) return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.map((p) => p.text ?? `[${p.type ?? "part"}]`).join("\n");
  if (msg.tool_calls)
    return `tool_calls: ${JSON.stringify(msg.tool_calls, null, 2)}`;
  return JSON.stringify(msg.content ?? msg);
}

async function cmdAi(args) {
  const { flags, pos } = parseFlags(args, {
    bool: ["--json", "--raw", "--full"],
    value: ["--since", "--model", "--limit", "--gateway", "--max"]
  });
  const gw = flags.gateway ?? AI_GW_DEFAULT;
  if (pos[0]) return cmdAiDetail(gw, pos[0], flags);

  const limit = parseLimit(flags.limit, 20);
  if (limit > AI_MAX_LIMIT)
    die(`--limit ${limit} is above the API maximum of ${AI_MAX_LIMIT}`);
  // Both filters go to the API, for the same reason `logs --grep` does: applied
  // here they would run *after* `per_page`, so `--since 2h` would search the
  // newest 20 calls and confidently report "no AI Gateway calls match" for a
  // window holding hundreds. The semantics are unchanged — `model` is a
  // case-insensitive substring match server-side too (verified: `opus`,
  // `claude-opus-5` and `CLAUDE-OPUS-5` all return the same set).
  const query = [
    ["per_page", String(limit)],
    ["order_by", "created_at"],
    ["order_by_direction", "desc"]
  ];
  if (flags.since)
    query.push([
      "start_date",
      new Date(Date.now() - parseSince(flags.since)).toISOString()
    ]);
  if (flags.model) query.push(["model", String(flags.model)]);

  const { res, text } = await request(
    "GET",
    acct(`ai-gateway/gateways/${gw}/logs`),
    { query }
  );
  ensureOk(res, text);
  if (flags.json || flags.raw) return void printBody(text, { raw: flags.raw });

  const json = parseJson(text);
  // Now the count of calls *matching the filters*, not of everything stored —
  // which is the number worth printing.
  const total = json?.result_info?.total_count;
  const logs = json?.result ?? [];
  if (logs.length === 0) return void out("no AI Gateway calls match");

  const byModel = {};
  let cost = 0;
  for (const l of logs) {
    byModel[l.model ?? "?"] = (byModel[l.model ?? "?"] ?? 0) + 1;
    cost += l.cost ?? 0;
  }
  const times = logs.map((l) => Date.parse(l.created_at));
  const modelStr = Object.entries(byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} (${v})`)
    .join(", ");
  out(
    `${logs.length} calls${flags.since ? ` in last ${flags.since}` : ""} · $${cost.toFixed(5)} · ${modelStr}`
  );
  const filtered = Boolean(flags.since || flags.model);
  out(
    `${hhmmss(Math.min(...times))} → ${hhmmss(Math.max(...times))}${total != null ? `  ·  ${total} ${filtered ? "matching" : "stored"}` : ""}`
  );
  out("");
  for (const l of logs) {
    const io = `${l.tokens_in ?? 0}→${l.tokens_out ?? 0}`.padEnd(11);
    const c = `$${(l.cost ?? 0).toFixed(5)}`.padEnd(9);
    const st = l.success ? (l.cached ? "cached" : "ok") : "FAIL";
    out(
      `${hhmmss(Date.parse(l.created_at))}  ${l.id}  ${(l.model ?? "?").padEnd(24)} ${io} ${c} ${`${l.duration ?? "?"}ms`.padEnd(8)} ${st}`
    );
  }
  // `total` is authoritative now, so this can say what is actually missing
  // rather than guessing from a page length.
  if (total != null && total > logs.length)
    out(
      `\n⚠ showing ${logs.length} of ${total} — raise --limit (max ${AI_MAX_LIMIT}) or narrow --since`
    );
}

async function cmdAiDetail(gw, id, flags) {
  const base = acct(`ai-gateway/gateways/${gw}/logs/${id}`);
  const meta = await request("GET", base);
  ensureOk(meta.res, meta.text);
  const reqR = await request("GET", `${base}/request`);
  ensureOk(reqR.res, reqR.text);
  const resR = await request("GET", `${base}/response`);
  ensureOk(resR.res, resR.text);

  if (flags.raw) {
    out(reqR.text);
    out("\n———\n");
    out(resR.text);
    return;
  }
  if (flags.json) {
    out(
      JSON.stringify(
        {
          meta: parseJson(meta.text)?.result ?? parseJson(meta.text),
          request: parseJson(reqR.text),
          response: parseJson(resR.text)
        },
        null,
        2
      )
    );
    return;
  }

  const max = flags.full ? Infinity : Number(flags.max ?? 1500);
  const m = parseJson(meta.text)?.result ?? {};
  const reqBody = parseJson(reqR.text) ?? {};
  const resBody = parseJson(resR.text) ?? {};
  const rule = "─".repeat(60);
  const st = m.success ? (m.cached ? "cached" : "ok") : "FAIL";
  out(
    `${m.created_at ?? "?"} · ${m.model ?? "?"} (${m.provider ?? "?"}) · ${m.tokens_in ?? 0}→${m.tokens_out ?? 0} tok · $${(m.cost ?? 0).toFixed(5)} · ${m.duration ?? "?"}ms · ${st}`
  );

  out(rule);
  const msgs = reqBody.messages;
  if (Array.isArray(msgs)) {
    out(`▶ REQUEST — ${msgs.length} message${msgs.length === 1 ? "" : "s"}`);
    for (const msg of msgs) {
      out(`\n[${msg.role}]`);
      out(truncate(messageText(msg), max));
    }
  } else {
    out("▶ REQUEST");
    out(truncate(JSON.stringify(reqBody, null, 2), max));
  }

  out(`\n${rule}`);
  const choice = resBody.choices?.[0];
  const reply = choice?.message;
  if (reply) {
    out(`◀ REPLY — finish: ${choice.finish_reason ?? "?"}`);
    out("");
    out(truncate(messageText(reply), max));
    if (reply.reasoning_content) {
      out("\n  reasoning:");
      out(`  ${truncate(reply.reasoning_content, max).replace(/\n/g, "\n  ")}`);
    }
  } else {
    out("◀ REPLY");
    out(truncate(JSON.stringify(resBody, null, 2), max));
  }
}

/** Enough of a digest to tell two builds apart; the rest is noise in a table. */
const shortDigest = (image) => {
  const at = String(image ?? "").lastIndexOf(":");
  return at === -1 ? "?" : String(image).slice(at + 1, at + 8);
};

const hhmmssIso = (iso) => (iso ? hhmmss(Date.parse(iso)) : "?");

/**
 * A rollout only says something about what is serving *now* while it is still
 * moving. `completed`, `reverted` and `replaced` are all terminal (the enum is
 * pending | progressing | completed | reverted | replaced), and a replaced one
 * was simply superseded by a newer deploy.
 */
const ROLLOUT_ACTIVE = new Set(["pending", "progressing"]);

/**
 * What each container application is actually running, and whether it is still
 * moving.
 *
 * This exists because `wrangler deploy` returning is **not** the same as the new
 * image serving, and nothing else says so. A deploy pushes an image and starts a
 * progressive rollout that takes minutes; a container started during it comes up
 * on whichever version its instance still holds. Testing inside that window
 * produces a failure indistinguishable from the fix not working — which has
 * already cost a full debugging round here.
 *
 * So the line that matters is the comparison: the image on the application
 * versus the image the active rollout is heading for. When they differ, some
 * instances are still serving the old one and nothing you test is conclusive.
 */
async function cmdContainers(args) {
  const { flags, pos } = parseFlags(args, { bool: ["--json", "--raw"] });
  const [name] = pos;

  const { res, text } = await request("GET", acct("containers/applications"), {
    query: [["per_page", "50"]]
  });
  ensureOk(res, text);

  const apps = (parseJson(text)?.result ?? []).filter(
    (a) => !name || String(a.name ?? "").includes(name)
  );
  // Fetched per app rather than in one call because the API has no bulk
  // rollout endpoint. There are a handful of apps; this is a debugging tool.
  const fetched = [];
  for (const app of apps) {
    const r = await request(
      "GET",
      acct(`containers/applications/${app.id}/rollouts`)
    );
    fetched.push({ app, ok: r.res.ok, text: r.text });
  }

  // The structured modes have to answer the same question as the digest, so
  // they carry the rollouts too — an app list alone cannot say whether the new
  // image is serving. --raw stays verbatim bodies (as in `ai <id> --raw`);
  // --json is the composite, filtered to what was asked for.
  if (flags.raw) {
    out(text);
    for (const f of fetched) out(`\n———\n${f.text}`);
    return;
  }
  if (flags.json) {
    out(
      JSON.stringify(
        fetched.map((f) => ({
          application: f.app,
          rollouts: f.ok ? (parseJson(f.text)?.result ?? []) : null,
          rollouts_error: f.ok ? undefined : (parseJson(f.text) ?? f.text)
        })),
        null,
        2
      )
    );
    return;
  }

  if (apps.length === 0)
    return void out(
      name ? `no app matching "${name}"` : "no container applications"
    );

  for (const { app, ok, text: rolloutText } of fetched) {
    const health = app.health?.instances ?? {};
    out(app.name ?? "?");
    out(
      `  version ${app.version ?? "?"} · image ${shortDigest(app.configuration?.image)} · ` +
        `${health.healthy ?? "?"}/${app.instances ?? "?"} healthy · updated ${app.updated_at ?? "?"}`
    );

    if (!ok) {
      out("  rollouts: unreadable");
      out("");
      continue;
    }
    const rollouts = parseJson(rolloutText)?.result ?? [];
    const latest = rollouts[0];
    if (!latest) {
      out("  no rollouts");
      out("");
      continue;
    }

    const target = shortDigest(latest.target_configuration?.image);
    const serving = shortDigest(app.configuration?.image);
    out(
      `  rollout ${String(latest.id ?? "?").slice(0, 8)} · ${latest.status ?? "?"} · ` +
        `to ${target}${target === serving ? "" : `  ⚠ differs from ${serving}`}`
    );
    for (const step of latest.steps ?? []) {
      const pct = step.step_size?.percentage;
      out(
        `    step ${step.id ?? "?"}  ${(step.status ?? "?").padEnd(10)} ` +
          `${String(pct === undefined ? "?" : `${pct}%`).padEnd(5)} ` +
          `${hhmmssIso(step.started_at)} → ${step.completed_at ? hhmmssIso(step.completed_at) : "…"}`
      );
    }
    const p = latest.progress;
    if (p)
      out(
        `    ${p.updated_instances ?? "?"}/${p.total_instances ?? "?"} instances on the target version`
      );
    // The only sentence anybody actually needs before testing. Terminal
    // statuses get their own line: a reverted rollout left instances off the
    // target image, and a replaced one was superseded so it says nothing about
    // what is serving. An unrecognised status is treated as inconclusive
    // rather than silently as fine — silence here is what cost the debugging
    // round this command exists to prevent.
    const status = latest.status ?? "?";
    if (ROLLOUT_ACTIVE.has(status))
      out(
        "    ⚠ still rolling — a container started now may be on the old image"
      );
    else if (status === "reverted")
      out(
        `    ⚠ reverted — instances were rolled back off ${target}, and are on ${serving}`
      );
    else if (status === "replaced")
      out(
        "    superseded by a newer rollout — this one says nothing about what is serving"
      );
    else if (status !== "completed")
      out(`    ⚠ unrecognised status "${status}" — treat as inconclusive`);
    out("");
  }
}

async function cmdRaw(args) {
  let method = "GET";
  if (METHODS.has(args[0]?.toUpperCase())) method = args.shift().toUpperCase();
  const path = args.shift();
  if (!path) die("missing <path>");
  const { flags } = parseFlags(args, {
    bool: ["--raw"],
    value: ["-d", "--data", "-q", "--query"]
  });
  // -q/--query is repeatable, but parseFlags keeps only the last; re-scan for all.
  const query = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-q" || args[i] === "--query") {
      const q = args[++i] ?? "";
      const eq = q.indexOf("=");
      if (eq === -1) die(`bad --query (expected k=v): ${q}`);
      query.push([q.slice(0, eq), q.slice(eq + 1)]);
    }
  }
  const data = flags.d ?? flags.data;
  let body;
  if (data !== undefined) {
    if (data.startsWith("@")) {
      const filename = data.slice(1);
      try {
        body = fs.readFileSync(filename, "utf8");
      } catch (err) {
        die(
          `could not read data file ${filename}: ${err?.message ?? String(err)}`
        );
      }
    } else {
      body = data;
    }
  }

  const apiPath = path.startsWith("/") ? path : acct(path);
  const { res, text } = await request(method, apiPath, { query, body });
  printBody(text, { raw: flags.raw });
  if (!res.ok) process.exit(1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  out(USAGE);
} else if (cmd === "verify") {
  const { res, text } = await request("GET", acct("tokens/verify"));
  printBody(text);
  if (!res.ok) process.exit(1);
} else if (cmd === "logs") {
  await cmdLogs(argv.slice(1));
} else if (cmd === "wf") {
  await cmdWf(argv.slice(1));
} else if (cmd === "ai") {
  await cmdAi(argv.slice(1));
} else if (cmd === "fields") {
  await cmdFields(argv.slice(1));
} else if (cmd === "containers") {
  await cmdContainers(argv.slice(1));
} else {
  await cmdRaw(argv);
}
