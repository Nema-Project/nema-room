import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DIAGRAM_TYPES, renderDiagram, validateDiagram } from "../src/archify.js";

// Real archify runs (a node child process each); a showcase validate takes a few seconds.
const ARCHIFY_TIMEOUT = 60_000;

const example = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../vendor/archify/examples/web-app.architecture.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

test("DIAGRAM_TYPES starts with the five core types", () => {
  expect(DIAGRAM_TYPES.slice(0, 5)).toEqual(["architecture", "workflow", "sequence", "dataflow", "lifecycle"]);
});

test(
  "validateDiagram accepts a vendored architecture example",
  async () => {
    await expect(validateDiagram("architecture", example())).resolves.toEqual({ ok: true });
  },
  ARCHIFY_TIMEOUT,
);

test(
  "validateDiagram returns diagnostics for a node with no id",
  async () => {
    const spec = example();
    const components = spec.components as Record<string, unknown>[];
    delete components[0]!.id;
    const result = await validateDiagram("architecture", spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContain("id");
    expect(result.diagnostics).toContain("/components/0");
    expect(Buffer.byteLength(result.diagnostics, "utf8")).toBeLessThanOrEqual(8 * 1024);
  },
  ARCHIFY_TIMEOUT,
);

test(
  "renderDiagram returns a self-contained HTML document with no external script src",
  async () => {
    const html = await renderDiagram("architecture", example());
    expect(html.trimStart().toLowerCase().startsWith("<!doctype html")).toBe(true);
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/<script[^>]*\ssrc=["']?https?:/i);
    expect(html).not.toMatch(/<link[^>]*\shref=["']?https?:/i);
  },
  ARCHIFY_TIMEOUT,
);
