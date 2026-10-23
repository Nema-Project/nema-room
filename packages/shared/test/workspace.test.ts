import { expect, test } from "vitest";
import { isBranchName } from "../src/index.js";

test("isBranchName rejects HEAD, main~3, x^, a b, a..b, -x, x.lock, x/ and accepts feature/a-b", () => {
  for (const bad of ["HEAD", "main~3", "x^", "a b", "a..b", "-x", "x.lock", "x/", "", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{1}", "a//b", "/a"]) {
    expect(isBranchName(bad), bad).toBe(false);
  }
  for (const good of ["main", "develop", "feature/a-b", "release/1.2", "v1.0"]) {
    expect(isBranchName(good), good).toBe(true);
  }
});
