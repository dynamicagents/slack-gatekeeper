// Every spec that can reach D1 or Durable Object storage must declare its own
// reset — `useStorageReset()` from test/helpers/storage.ts, at the top of the
// file. Nothing resets storage globally any more, so a spec that seeds a row and
// forgets the call does not fail: it leaks, and the next spec to run fails
// instead. This catches that at `npm run check` rather than in someone else's
// suite.
//
// The heuristic is deliberately crude and deliberately one-directional:
//
//   - It flags a spec that *looks like* it touches storage without declaring the
//     reset. That is the failure mode that costs an afternoon.
//   - It never flags a spec that declares the reset it does not need. Over-
//     declaring is slow, not wrong, and the call is meant to be safe to add when
//     unsure.
//
// Reachability follows relative imports inside test/, so a spec inherits the
// markers of the helpers it pulls in — `helpers/workspace.ts` writes to D1, and a
// spec that imports it counts as touching storage even if it never says "@/db".
import fs from "node:fs";
import path from "node:path";

const TEST_DIR = "test";
const HELPER_CALL = "useStorageReset(";

/** What "this file can reach storage" looks like in source. */
const MARKERS = [
  { why: 'imports "@/db/…"', re: /from\s+"@\/db(?:\/[^"]*)?"/ },
  { why: "uses env.DB", re: /\benv\.DB\b/ },
  {
    why: "drives a Durable Object",
    re: /\b(?:runInDurableObject|runDurableObjectAlarm|listDurableObjectIds)\b/
  },
  { why: "fetches through SELF", re: /\bSELF\b/ },
  {
    why: "imports the worker entrypoint",
    re: /from\s+"(?:(?:\.\.?\/)+src\/server|@\/server)"/
  }
];

/** Every `.ts` under test/, so a spec's helpers can be inspected too. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const sources = new Map(
  walk(TEST_DIR).map((file) => [file, fs.readFileSync(file, "utf8")])
);

/** Relative imports that land inside test/ — the ones worth following. */
function localImports(file, src) {
  const dir = path.dirname(file);
  const found = new Set();
  for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
    const base = path.normalize(path.join(dir, spec));
    for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
      if (sources.has(candidate)) found.add(candidate);
    }
  }
  return found;
}

/** The first marker `file` or anything it imports matches, or null. */
function storageMarker(file, root = file, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  const src = sources.get(file);
  if (src === undefined) return null;
  for (const marker of MARKERS) {
    if (marker.re.test(src)) {
      return file === root ? marker.why : `${marker.why} (via ${file})`;
    }
  }
  for (const imported of localImports(file, src)) {
    const hit = storageMarker(imported, root, seen);
    if (hit) return hit;
  }
  return null;
}

const offenders = [];
for (const [file, src] of sources) {
  if (!file.endsWith(".spec.ts")) continue;
  if (src.includes(HELPER_CALL)) continue;
  const why = storageMarker(file);
  if (why) offenders.push({ file, why });
}

if (offenders.length > 0) {
  console.error(
    "check-storage-reset: spec files reach storage without resetting it.\n" +
      "Add `useStorageReset()` from test/helpers/storage.ts at the top of each,\n" +
      "directly under the imports and above every other hook:\n"
  );
  for (const { file, why } of offenders) console.error(`  ${file} — ${why}`);
  process.exit(1);
}

console.log(
  `check-storage-reset: ${sources.size} test files scanned, no unreset storage.`
);
