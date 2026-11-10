import { describe, expect, test } from "vitest";
import { sharePeerDecision as sourceDecision } from "../src/sharePeer.js";

const plainUrl = new URL("../../../scripts/desktop/templates/share-peer.mjs", import.meta.url).href;
const { sharePeerDecision: plainDecision } = (await import(plainUrl)) as {
  sharePeerDecision: typeof sourceDecision;
};

const cases: Array<[string | null, Record<string, string>, "allow" | "reject"]> = [
  ["127.0.0.1", {}, "allow"],
  ["192.168.1.10", {}, "allow"],
  ["fd00::10", {}, "allow"],
  ["fc00::1", {}, "allow"],
  ["fdff::1", {}, "allow"],
  ["fe80::1%eth0", {}, "allow"],
  ["febf::1", {}, "allow"],
  ["[::1]", {}, "allow"],
  ["::ffff:192.168.0.5", {}, "allow"],
  ["::1", {}, "allow"],
  ["8.8.8.8", {}, "reject"],
  ["172.32.0.1", {}, "reject"],
  ["0.0.0.0", {}, "reject"],
  ["::", {}, "reject"],
  ["example.com", {}, "reject"],
  ["fec0::1", {}, "reject"],
  ["fe00::1", {}, "reject"],
  ["10.1.2.3", { "x-forwarded-for": "10.0.0.1" }, "reject"],
  ["203.0.113.5", { "X-Forwarded-For": "10.0.0.5" }, "reject"],
  [null, {}, "reject"],
  ["::1", { forwarded: "for=127.0.0.1" }, "reject"],
];

describe("share peer copies", () => {
  test("the plain Node guard matches the runtime decision", () => {
    for (const [peer, headers, decision] of cases) {
      expect(sourceDecision(peer, headers), String(peer)).toBe(decision);
      expect(plainDecision(peer, headers), String(peer)).toBe(decision);
    }
  });
});
