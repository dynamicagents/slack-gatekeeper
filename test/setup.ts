import { beforeEach } from "vitest";
import { clearJwksCache } from "@/a2a/card-verify";

// The one thing every spec gets, whatever it tests.
//
// Module state is part of a test's clean slate. A test file shares one isolate
// across its cases, so the JWKS cache would otherwise carry one test's stubbed
// keys into the next — the same `jku` served by a fresh `vi.stubGlobal("fetch")`
// and a newly generated key pair each time. Clearing it here is what makes a
// cold isolate, which is what the production behaviour every case describes
// assumes. It is cheap, and a cache that leaks is the kind of bug that surfaces
// as someone else's failure, so it is never opt-in.
//
// Storage is the opposite: resetting D1 and Durable Object storage means
// replaying every migration, which only the specs that read or write storage
// should pay for. Those declare it themselves with `useStorageReset()` from
// test/helpers/storage.ts, at the top of the file, so the cost and the reason
// for it sit next to the tests that incur them.
beforeEach(() => {
  clearJwksCache();
});
