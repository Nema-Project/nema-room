# 聊天附件：真实模型验收（OpenRouter BYOK）

本文件给 [聊天附件设计](../superpowers/specs/2026-10-30-chat-attachments-design.md) 的能力表补真实模型的记录，包括可复跑的步骤（第 1–5 节）和 2026-10-30 的实测结果（第 6 节）。它只覆盖一种配置：`codex-direct` + `byok`，`byokBaseUrl` 为 `https://openrouter.ai/api/v1`，模型是 OpenRouter 上带 `:free` 的多模态模型。其他组合（`claude-code`、`siwc`、默认地址的 `byok`、`compat`）不在这里，结论不变。

`compat` 读的是 Codex CLI 的 ChatGPT 登录（`~/.codex/auth.json`），请求发往 `chatgpt.com/backend-api/codex`，**OpenRouter 的 API key 用不了 `compat`**。用 OpenRouter 测的是 `byok` 改了地址的那一行。

## 0. 规则

- 只用已有的凭据，不申请新 key，不充值，不换付费模型。免费模型限流（429）或不可用，照实记下。
- **PDF 会花钱。**模型不能原生读文件、请求又没指定解析引擎时，OpenRouter 默认用付费的 `mistral-ocr`（每 1000 页 2 美元，BYOK 也照收）解析 PDF。Nema 不指定引擎，所以经 OpenRouter 发 PDF 会悄悄扣费（见第 6 节）。复跑时不要再发 PDF，除非确认要承担这笔费用。
- key 只从进程环境变量 `OPENROUTER_API_KEY` 读：不打印，不写进任何文件、仓库或日志，而且**只交给 daemon 进程**。`npm ci`、构建、hub、web 和发送脚本都用 `env -u OPENROUTER_API_KEY` 启动，免得安装脚本或无关的服务端代码读到它。Nema 平时把 BYOK key 存进 `~/.nema/byok-key`，所以验收时用第 2 节的临时补丁改为从环境读，不运行 `nema auth byok`。
- 补丁只在一次性检出里，**不提交、不推送**。没有设 `NEMA_ACCEPTANCE=1` 的进程和 main 的行为完全一样。
- 结果只记真实输出。改能力表要单独开 PR，只改实测通过的那一格，而且只针对 OpenRouter 这一个地址。

## 1. 在这台机器上起 Nema（hub + web + daemon）

执行环境是 Debian 13、Node 24，没有 Docker，也没有 PostgreSQL 服务端（只有 `psql` 等客户端）。所以 hub 用桌面版同款的 PGlite（`createLocalDb`），由一次性启动脚本 `/tmp/nema-acc/hub.mts` 代替 `apps/hub/src/main.ts`，区别只有数据库：

```ts
// One-off acceptance launcher: apps/hub/src/main.ts with PGlite (as the desktop app uses) instead of PostgreSQL.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalDb } from "/workspace/nr-acc/apps/hub/src/db/pglite.ts";
import { readHubReleaseVersion } from "/workspace/nr-acc/apps/hub/src/hubVersion.ts";
import { startHub } from "/workspace/nr-acc/apps/hub/src/lifecycle.ts";

const dataDir = "/tmp/nema-acc/data";
await mkdir(dataDir, { recursive: true });
const tokenFile = path.join(dataDir, "daemon-token");
const daemonToken = await readFile(tokenFile, "utf8").then((s) => s.trim(), async () => {
  const t = randomBytes(32).toString("hex");
  await writeFile(tokenFile, t, { mode: 0o600 });
  return t;
});
const db = await createLocalDb(path.join(dataDir, "pglite"));
const hub = await startHub({
  db, dataDir, nemaHome: "/tmp/nema-acc/home/.nema", daemonToken, releaseVersion: readHubReleaseVersion(),
  port: 4400, hostname: "127.0.0.1", webOrigin: "http://127.0.0.1:3000,http://localhost:3000", cleanDaemonDirs: true,
});
console.log(`nema hub listening (use ${hub.url})`);
const stop = () => void hub.close().finally(() => db.close());
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
```

```bash
git worktree add --detach /workspace/nr-acc origin/main
cd /workspace/nr-acc
env -u OPENROUTER_API_KEY npm ci
env -u OPENROUTER_API_KEY npm run typecheck   # 顺带生成各包的 dist，hub 依赖 @nema/knowledge 的 dist
# 应用第 2 节的临时补丁
env -u OPENROUTER_API_KEY npm run build -w apps/cli
mkdir -p /tmp/nema-acc/data /tmp/nema-acc/home

# hub：http://127.0.0.1:4400
env -u OPENROUTER_API_KEY setsid nohup npx tsx /tmp/nema-acc/hub.mts > /tmp/nema-acc/hub.log 2>&1 < /dev/null &
# daemon：HOME 指向一次性目录，不碰真实的 ~/.nema；只有它继承 key
HOME=/tmp/nema-acc/home NEMA_ACCEPTANCE=1 NEMA_DATA_DIR=/tmp/nema-acc/data \
  setsid nohup node apps/cli/dist/index.js daemon --hub http://127.0.0.1:4400 > /tmp/nema-acc/daemon.log 2>&1 < /dev/null &
# web：http://127.0.0.1:3000
env -u OPENROUTER_API_KEY NEXT_PUBLIC_HUB_URL=http://127.0.0.1:4400 setsid nohup npm run dev -w apps/web > /tmp/nema-acc/web.log 2>&1 < /dev/null &
```

判定：`hub.log` 有 `nema hub listening (use http://127.0.0.1:4400)`；`daemon.log` 有 `[nema] daemon connected to http://127.0.0.1:4400`；`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/` 为 200；`curl -s http://127.0.0.1:4400/api/daemon/attachment-capabilities` 返回 `{"adapter":"codex-direct (byok)",...}`。

## 2. 把 OpenRouter 配成 BYOK

```bash
cd /workspace/nr-acc
export HOME=/tmp/nema-acc/home   # 只对这几条命令；之后改回
C="node apps/cli/dist/index.js"
$C config set adapter codex-direct
$C config set authMode byok
$C config set byokBaseUrl https://openrouter.ai/api/v1
$C config set model nvidia/nemotron-3.5-super-vl:free
```

两处临时补丁，都只在 `NEMA_ACCEPTANCE=1` 时生效：

1. `apps/cli/src/direct/byok.ts` 的 `readByokKey` 开头：`NEMA_ACCEPTANCE=1` 且有 `OPENROUTER_API_KEY` 时直接返回环境变量的值。
2. `apps/cli/src/attachments/capabilities.ts` 在 `siwc` 那一行之后：`NEMA_ACCEPTANCE=1`、`authMode` 为 `byok` 且 `byokBaseUrl` 恰为 `https://openrouter.ai/api/v1` 时返回与 `siwc` 相同的表（图片、PDF 为 `native`），好让附件真的发出去；否则这一行是 `unknown`，运行前就被拒绝，测不到模型。

`git status` 里能看到这两个改动；验收结束后 `git checkout -- apps/cli/src` 丢掉。daemon 每个任务都重读配置，换模型只要 `config set model`，不用重启。

模型顺序：主测 `google/gemma-4-31b-it:free`；限流或报错时依次换 `nvidia/nemotron-3.5-super-vl:free`、`thinkingmachines/inkling:free`。不用 `nemotron-3.5-content-safety`（安全分类模型）。

## 3. 样本

每个样本带一个只在文件里出现、消息文字里没有的随机暗号。`/tmp/nema-acc/make-samples.py <目录>`（需要 Pillow）写出 `sample.png`、`sample.pdf`、`sample.txt` 和 `words.json`：

```python
#!/usr/bin/env python3
"""Writes three attachment samples, each carrying its own random word that appears nowhere else."""
import json, secrets, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
out.mkdir(parents=True, exist_ok=True)
words = {k: f"{k.upper()}-{secrets.token_hex(3).upper()}" for k in ("img", "pdf", "txt")}

img = Image.new("RGB", (900, 260), "white")
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("DejaVuSans-Bold.ttf", 72)
except OSError:
    font = ImageFont.load_default(size=72)
d.text((40, 90), words["img"], fill="black", font=font)
img.save(out / "sample.png")

text = f"Acceptance sample. The code word is {words['pdf']} and nothing else."
stream = f"BT /F1 14 Tf 72 700 Td ({text}) Tj ET".encode()
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
pdf = bytearray(b"%PDF-1.4\n")
offsets = []
for i, o in enumerate(objs, 1):
    offsets.append(len(pdf))
    pdf += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(pdf)
pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
pdf += b"".join(b"%010d 00000 n \n" % off for off in offsets)
pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
(out / "sample.pdf").write_bytes(bytes(pdf))

(out / "sample.txt").write_text(f"Acceptance sample.\nThe code word is {words['txt']}.\n", encoding="utf-8")
(out / "words.json").write_text(json.dumps(words, indent=2) + "\n", encoding="utf-8")
print(json.dumps(words))
```

PDF 用 14 pt 字号：最初用 24 pt，暗号末尾一个字符落在页面右边界之外，`pdftotext` 也读不到（见第 6 节）。生成后用 `pdftotext sample.pdf -` 确认整句都在页面内，并用 `sniffAttachment` 确认三个文件分别判成 `image/png`、`application/pdf`、`text/plain`。

## 4. 发送与判定

`env -u OPENROUTER_API_KEY node /tmp/nema-acc/run.mjs <样本目录> <模型 id> [img,pdf,txt]` 用 hub 的 HTTP API（和 web 同一组路由）建一个一次性 workspace，每个样本上传后发一条只带它的消息，等 agent 回复或任务失败的 system 消息，结果追加到 `/tmp/nema-acc/results.jsonl`：

```js
// Acceptance run: one workspace, one message per sample, via the hub HTTP API (same routes as the web).
import { randomUUID } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
const HUB = "http://127.0.0.1:4400/api";
const [dir, model, only] = process.argv.slice(2);
const words = JSON.parse(readFileSync(`${dir}/words.json`, "utf8"));
const jst = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }) + " JST";
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const ws = await j(await fetch(`${HUB}/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `acc ${model.split("/").pop()} ${Date.now() % 100000}` }) }));
const samples = [["sample.png", "img"], ["sample.pdf", "pdf"], ["sample.txt", "txt"]].filter(([, k]) => !only || only.split(",").includes(k));
for (const [file, k] of samples) {
  const up = await fetch(`${HUB}/workspaces/${ws.id}/attachments`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-nema-filename": encodeURIComponent(file), "x-nema-upload-key": randomUUID() }, body: readFileSync(`${dir}/${file}`) });
  const view = await j(up);
  const started = jst();
  const posted = await j(await fetch(`${HUB}/workspaces/${ws.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "附件里写的暗号是什么？只回答暗号本身。", attachmentIds: [view.id] }) }));
  const mid = posted.message?.id;
  let reply = null;
  for (let i = 0; i < 120 && !reply; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const list = await j(await fetch(`${HUB}/workspaces/${ws.id}/messages`));
    const idx = list.findIndex((m) => m.id === mid);
    reply = list.slice(idx + 1).find((m) => m.role !== "user") ?? null;
  }
  const text = reply ? String(reply.content) : "(no reply within 10 min)";
  const pass = text.includes(words[k]);
  const rec = { started, finished: jst(), model, workspace: ws.id, file, upload: up.status, attachment: view.id, word: words[k], role: reply?.role ?? null, pass, reply: text.slice(0, 1500) };
  console.log(JSON.stringify(rec));
  appendFileSync("/tmp/nema-acc/results.jsonl", JSON.stringify(rec) + "\n");
}
console.log(`workspace ${ws.id}`);
```

| 结果 | 条件 |
| --- | --- |
| 通过 | agent 回复里逐字出现该样本的暗号 |
| 不通过 | 任务成功但回复里没有完整暗号，或说看不到附件 |
| 出错 / 限流 | 任务失败；记下 system 消息原文（不含凭据） |

## 5. 记录

每次调用在第 6 节加一行：开始时间（JST）、模型 id、样本、暗号、结果、回复原文。结论写进设计记录的「真实模型验收记录」。只有「通过」的格子可以在单独的 PR 里从 `unknown` 改掉，并且只针对 `https://openrouter.ai/api/v1`。

## 6. 2026-10-30 的结果

环境：`/workspace/nr-acc` 检出 main `94ecb33`，加第 2 节的临时补丁；hub、web、daemon 按第 1 节启动。实测时 hub 和 web 进程也继承了 key（第 0 节的「只交给 daemon」是事后补上的），22:35 JST 已不带 key 重启。实测后把补丁 2 收紧为只放开图片（PDF 仍 `unknown`），供浏览器截图使用，免得再触发 OCR 计费。提问固定为「附件里写的暗号是什么？只回答暗号本身。」

| 开始（JST） | 模型 | 样本 | 暗号 | 结果 | 回复原文 |
| --- | --- | --- | --- | --- | --- |
| 22:18:33 | `google/gemma-4-31b-it:free` | sample.png | `IMG-4AEB67` | 限流 | 处理失败：模型接口错误：HTTP 429：Provider returned error |
| 22:18:38 | `google/gemma-4-31b-it:free` | sample.pdf | `PDF-35F475` | 限流 | 处理失败：模型接口错误：HTTP 429：Provider returned error |
| 22:18:43 | `google/gemma-4-31b-it:free` | sample.txt | `TXT-F84710` | 限流 | 处理失败：模型接口错误：HTTP 429：Provider returned error |
| 22:20:32 | `nvidia/nemotron-3.5-super-vl:free` | sample.png | `IMG-4FA65A` | 通过 | IMG-4FA65A |
| 22:20:42 | `nvidia/nemotron-3.5-super-vl:free` | sample.pdf | `PDF-DCB758` | 不通过（样本缺陷） | PDF-DCB75 |
| 22:21:22 | `nvidia/nemotron-3.5-super-vl:free` | sample.txt | `TXT-94CD1F` | 通过 | TXT-94CD1F |
| 22:21:56 | `nvidia/nemotron-3.5-super-vl:free` | sample.pdf | `PDF-B3522A` | 不通过（样本缺陷） | PDF-B3522 |
| 22:22:06 | `nvidia/nemotron-3.5-super-vl:free` | sample.pdf | `PDF-D5E1FC` | 不通过（样本缺陷） | PDF-D5E1F |
| 22:22:41 | `nvidia/nemotron-3.5-super-vl:free` | sample.pdf | `PDF-434934` | 通过 | PDF-434934 |
| 22:23:00 | `nvidia/nemotron-3.5-super-vl:free` | sample.pdf | `PDF-FBC4A1` | 通过 | PDF-FBC4A1 |
| 22:23:10 | `nvidia/nemotron-3.5-super-vl:free` | sample.pdf | `PDF-380A0B` | 通过 | PDF-380A0B |
| 22:23:39 | `nvidia/nemotron-3.5-super-vl:free` | sample.png | `IMG-05016B` | 通过 | IMG-05016B |
| 22:24:04 | `nvidia/nemotron-3.5-super-vl:free` | sample.pdf | `PDF-71354D` | 通过 | PDF-71354D |
| 22:24:09 | `nvidia/nemotron-3.5-super-vl:free` | sample.txt | `TXT-4DEAF2` | 通过 | TXT-4DEAF2 |
| 22:24:24 | `google/gemma-4-31b-it:free` | sample.png | `IMG-42413D` | 限流 | 处理失败：模型接口错误：HTTP 429：Provider returned error |
| 22:24:29 | `google/gemma-4-31b-it:free` | sample.pdf | `PDF-6144D8` | 限流 | 处理失败：模型接口错误：HTTP 429：Provider returned error |
| 22:24:34 | `google/gemma-4-31b-it:free` | sample.txt | `TXT-AD4D13` | 限流 | 处理失败：模型接口错误：HTTP 429：Provider returned error |

- `google/gemma-4-31b-it:free`：两轮共 6 次（22:18、22:24）全部是 `HTTP 429：Provider returned error`，没有拿到任何回复。按规则换下一个模型，没有换付费模型。
- `nvidia/nemotron-3.5-super-vl:free`：图片 2/2、文本 2/2 逐字通过。
- PDF：22:20、22:21、22:22:06 三次回复都少最后一个字符。原因是样本：24 pt 的句子超出 612 pt 宽的页面，末字符在页面外，`pdftotext` 同样读不到。22:22:41 把暗号移到句中、22:23 起改用 14 pt 后，4/4 逐字通过。
- `thinkingmachines/inkling:free` 没有用到。
- 费用：验收后用同一把 key 查 `GET https://openrouter.ai/api/v1/key`，当天 `usage` 为 0.014 美元（`is_free_tier: true`，`limit` 50）。与 nemotron 收到的 7 份单页 PDF 按 `mistral-ocr` 0.002 美元一页正好相符（推断：这个接口不给逐次明细）。图片和文本只用了免费模型。

结论：

| 格子 | 结论 |
| --- | --- |
| 图片 | 通过：模型直接读到图里的暗号。单独开 PR，只对 `https://openrouter.ai/api/v1` 改成 `native` |
| PDF | 内容读到了，但读的是 OpenRouter 付费 OCR 的输出，而且每次悄悄扣费。保持 `unknown`、运行前拒绝 |
| 文本 | 通过；文本一向按文字发送（`text`），能力表本来就允许，不用改 |

## 7. 2026-10-30 23:06 JST：D-2 修订后的补测（错误翻译与发送格式）

D-2 在 22:59 JST 修订为「`codex-direct` 一律按原生格式发，提供商拒绝时如实翻译」（见设计记录 D-2 一节末尾）。这次补测只验证图片的发送格式和错误翻译，**不发 PDF**：免费模型都没有原生文件能力，发 PDF 会触发 OpenRouter 的付费 OCR，要先征得用户同意。

做法：一次性脚本直接调用 Nema 的 `streamResponse`（`apps/cli/src/direct/transport.ts`，`stream: true`，不带 tools），`baseUrl` 为 `https://openrouter.ai/api/v1`。key 只在进程内从 `OPENROUTER_API_KEY` 读，不落盘、不打印。失败时把错误交给 `attachmentRejection`（`apps/cli/src/direct/attachmentErrors.ts`）。图片是一张 900×260 的 PNG，上面写着随机暗号 `IMG-8BB7AC`。

| 开始（JST） | 模型 | 附件 | 结果 | 原文 / 回复 | Nema 显示 |
| --- | --- | --- | --- | --- | --- |
| 23:06:50 | `liquid/lfm-2.5-2.6b:free`（只收文字） | 图片 | 提供商拒绝 | `HTTP 404：No endpoints found that support image input` | 你的提供商或模型拒绝了这张图片（「code.png」）。提供商原文：HTTP 404：No endpoints found that support image input。Nema 按提供商的原生格式发送，没有转换，也没有重试。 |
| 23:06:50 | `nvidia/nemotron-3.5-lightning:free`（只收文字） | 图片 | 提供商拒绝 | 同上 | 同上 |
| 23:06:50 | `nvidia/nemotron-3.5-super-vl:free` | 图片 | 通过 | `IMG-8BB7AC` | — |
| 23:06:51 | `nema-acceptance/no-such-model:free`（不存在） | 无 | 提供商拒绝 | `HTTP 400：… is not a valid model ID` | 不翻译，照原样显示 |
| 23:06:51 | 同上 | 图片 | 提供商拒绝 | 同上 | 不翻译（错误与附件无关），照原样显示 |

前后查 `GET /api/v1/key`：`usage` 都是 0.014 美元（第 6 节那笔），新增 0。

