import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { sharePeerDecision as sourceDecision } from "../src/sharePeer.js";

const plainDecision = (createRequire(import.meta.url)("../../../scripts/desktop/templates/share-peer.mjs") as {
  sharePeerDecision: typeof sourceDecision;
}).sharePeerDecision;

const cases: Array<[string | null, Record<string, string>]> = [
  ["127.0.0.1", {}],
  ["192.168.1.10", {}],
  ["fd00::10", {}],
  ["fe80::1%eth0", {}],
  ["::ffff:192.168.0.5", {}],
  ["::1", {}],
  ["8.8.8.8", {}],
  ["172.32.0.1", {}],
  ["0.0.0.0", {}],
  ["::", {}],
  ["example.com", {}],
  ["10.1.2.3", { "x-forwarded-for": "10.0.0.1" }],
  ["203.0.113.5", { "X-Forwarded-For": "10.0.0.5" }],
  [null, {}],
  ["::1", { forwarded: "for=127.0.0.1" }],
];

describe("share peer copies", () => {
  test("the plain Node guard matches the runtime decision", () => {
    for (const [peer, headers] of cases) {
      expect(plainDecision(peer, headers), String(peer)).toBe(sourceDecision(peer, headers));
    }
  });
});
