// #299 batch 0: daemon texts the hub matches, and hub texts the daemon matches, come from @nema/shared.
import { MIRROR_URL_ERROR, VERSION_SKEW_MARKER, isUnknownRpcMethodError, nemaCliSpec } from "@nema/shared";
import { expect, test } from "vitest";
import { normalizeMirrorUrl } from "../src/config.js";
import { skewGuidance } from "../src/daemon/connection.js";
import { RpcRouter } from "../src/daemon/rpc.js";

test("the router's unknown-method error is what the hub's older-daemon check recognizes", async () => {
  const response = await new RpcRouter().handle({ type: "rpc.request", id: "1", method: "skills.catalog", params: {} });
  expect(response.ok).toBe(false);
  expect(isUnknownRpcMethodError((response as { error: string }).error)).toBe(true);
});

test("skew guidance keys on the shared marker and spec, not on a copied wording", () => {
  expect(skewGuidance(`refused (${VERSION_SKEW_MARKER}); install ${nemaCliSpec("1.2.3")}`)).toBe(`run: npm i -g ${nemaCliSpec("1.2.3")}`);
  expect(skewGuidance(`refused (${VERSION_SKEW_MARKER})`)).toBe("run: npm i -g @nema-project/nema@<hub 版本>\n请先查看正在运行的 hub 的版本");
  expect(skewGuidance(`proxy refused ${nemaCliSpec("1.2.3")}`)).toBeNull();
});

test("a rejected mirror URL throws the shared mirror error the hub maps to 400", () => {
  for (const raw of ["ftp://mirror.example", "https://u:p@mirror.example", "https://mirror.example/?q", "not a url"]) {
    expect(() => normalizeMirrorUrl(raw)).toThrow(MIRROR_URL_ERROR);
  }
});
