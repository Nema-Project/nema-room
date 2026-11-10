import { describe, expect, it } from "vitest";
import { isPrivateSharePeer, sharePeerDecision } from "@/lib/sharePeer";

describe("share peer", () => {
  it("allows one address from each private prefix", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.10", "169.254.1.1", "::1", "fd00::1", "fc00::1", "fe80::1", "fe80::1%eth0", "::ffff:192.168.0.5"]) {
      expect(isPrivateSharePeer(address), address).toBe(true);
      expect(sharePeerDecision(address, {})).toBe("allow");
    }
  });

  it("rejects public, documentation, and shared addresses", () => {
    for (const address of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "203.0.113.5", "2001:db8::1", "::ffff:8.8.8.8", "::", "0.0.0.0"]) {
      expect(isPrivateSharePeer(address), address).toBe(false);
      expect(sharePeerDecision(address, {})).toBe("reject");
    }
  });

  it("rejects any forwarding header without reading it as the peer", () => {
    expect(sharePeerDecision("10.1.2.3", { "x-forwarded-for": "10.0.0.1" })).toBe("reject");
    expect(sharePeerDecision("203.0.113.5", { "X-Forwarded-For": "10.0.0.5" })).toBe("reject");
    expect(sharePeerDecision("127.0.0.1", { forwarded: "for=127.0.0.1" })).toBe("reject");
    expect(sharePeerDecision("127.0.0.1", { "X-Real-IP": "10.0.0.1" })).toBe("reject");
    expect(sharePeerDecision("::1", { "cf-connecting-ip": "10.0.0.1" })).toBe("reject");
    expect(sharePeerDecision("fd00::1", { "true-client-ip": "10.0.0.1" })).toBe("reject");
    expect(sharePeerDecision("192.168.0.1", { "x-forwarded-host": "share.example" })).toBe("reject");
  });

  it("rejects a missing peer", () => {
    expect(sharePeerDecision(null, {})).toBe("reject");
    expect(sharePeerDecision(undefined, {})).toBe("reject");
  });
});
