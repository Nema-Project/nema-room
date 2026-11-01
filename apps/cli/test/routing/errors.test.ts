import { describe, expect, test } from "vitest";
import { classifyFailure, shouldSwitch } from "../../src/routing/errors.js";
import { AuthRateLimitedError, ReloginRequiredError } from "../../src/direct/authStore.js";
import { ByokRejectedError, ModelApiError, ModelQuotaError } from "../../src/direct/transport.js";

const api = (status: number, message = "boom") => new ModelApiError({ status, message });
const classify = (e: unknown, startedOutput = false) => classifyFailure(e, { startedOutput });

describe("classifyFailure", () => {
  test("output that already reached the user is never re-routed", () => {
    // Whatever failed after a delta arrived, the user has seen part of the answer; a second account would
    // produce a different one.
    for (const e of [api(429), api(500), new ModelQuotaError({ status: 429 }), new Error("x")]) {
      expect(classify(e, true)).toBe("streaming_started");
    }
  });

  test("maps quota and credential errors to their own kinds", () => {
    expect(classify(new ModelQuotaError({ status: 429, code: "usage_limit_reached" }))).toBe("quota");
    expect(classify(new ByokRejectedError())).toBe("auth");
    expect(classify(new ReloginRequiredError("invalid_grant"))).toBe("auth");
    expect(classify(new AuthRateLimitedError(30))).toBe("rate_limit");
  });

  test("maps API statuses to routeable and non-routeable kinds", () => {
    expect(classify(api(429))).toBe("rate_limit");
    expect(classify(api(500))).toBe("server");
    expect(classify(api(503))).toBe("server");
    expect(classify(api(401))).toBe("auth");
    expect(classify(api(403))).toBe("policy");
    expect(classify(api(422))).toBe("bad_request");
  });

  test("recognises a context-length rejection by what the provider said, not only by its status", () => {
    for (const message of [
      "context_length_exceeded",
      "This model's maximum context window is 8192 tokens",
      "too many tokens in the request",
      "prompt is too long: 300000 tokens",
    ]) {
      expect(classify(api(400, message)), message).toBe("context");
    }
    expect(classify(api(413, "request entity too large"))).toBe("bad_request");
  });

  test("an unrecognised error is unknown rather than a guess", () => {
    expect(classify(new Error("socket hang up"))).toBe("unknown");
    expect(classify(api(400, "invalid request body"))).toBe("bad_request");
  });
});

describe("shouldSwitch", () => {
  test("switches on the failures that are about this account's limit, not this request", () => {
    for (const failure of ["rate_limit", "quota", "server", "context"] as const) {
      const d = shouldSwitch(failure);
      expect(d.switch, failure).toBe(true);
    }
  });

  test("does not switch on credential, policy, request or mid-stream failures, and says why", () => {
    const reasons = new Set<string>();
    for (const failure of ["auth", "policy", "bad_request", "streaming_started", "unknown"] as const) {
      const d = shouldSwitch(failure);
      expect(d.switch, failure).toBe(false);
      if (d.switch) throw new Error("unreachable");
      expect(d.because.trim()).not.toBe("");
      reasons.add(d.because);
    }
    // Each refusal has its own sentence: "why did it not switch" is a question the user can ask.
    expect(reasons.size).toBe(5);
  });
});
