import assert from "node:assert/strict";
import test from "node:test";
import { interpretReportingStatus } from "./reporting-status.mjs";

test("enabled and disabled are distinct from an unreadable response", () => {
  assert.deepEqual(interpretReportingStatus(200, { enabled: false }), { state: "disabled", enabled: false });
  assert.deepEqual(interpretReportingStatus(200, { enabled: true }), { state: "enabled", enabled: true });
  for (const sample of [interpretReportingStatus(404, { enabled: false }), interpretReportingStatus(200, {}), interpretReportingStatus(200, null), interpretReportingStatus(403, { message: "no" })]) {
    assert.equal(sample.state, "unknown");
    assert.equal(sample.enabled, null);
  }
});
