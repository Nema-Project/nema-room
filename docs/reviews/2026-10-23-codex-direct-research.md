# Running an LLM tool loop on a ChatGPT/Codex subscription without the Codex CLI

How Hermes Agent's `openai-codex` provider does it, checked against openai/codex (codex-rs). Written as input to a TypeScript design spec.

Research date: 2026-10-22. Nothing was logged in, no OpenAI endpoint was called, and `~/.codex/auth.json` was not read.

## Sources (pinned commits)

- **Hermes:** `NousResearch/hermes-agent` @ `8237c7f8ec179c88857f24a174509d985af704b7` (main). Below, `H:` means `https://github.com/NousResearch/hermes-agent/blob/8237c7f8ec179c88857f24a174509d985af704b7/`.
- **Codex:** `openai/codex` @ `94350a910143c406013683ae634708320f93f1f6` (main). Below, `C:` means `https://github.com/openai/codex/blob/94350a910143c406013683ae634708320f93f1f6/`.
- **OpenAI developer docs (fetched 2026-10-22):**
  - https://learn.chatgpt.com/docs/auth (the old developers.openai.com/codex/auth redirects here)
  - https://developers.openai.com/siwc/quickstart
  - https://developers.openai.com/siwc/token-sharing-open-source/sign-in
  - https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
  - https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery

Labels used below:
- **[C]** Confirmed by the cited source.
- **[I]** Inferred.
- **[U]** Unknown.

---

## 0. Read this first: the endpoint Hermes uses is not the sanctioned one

**[C] Hermes's default.** The `openai-codex` profile uses `api_mode="codex_responses"` and `base_url="https://chatgpt.com/backend-api/codex"`, with `auth_type="oauth_external"`.
- Source: `H:plugins/model-providers/openai-codex/__init__.py` L6-10 and `H:hermes_cli/providers.py` L32-33.

**[C] Hermes does not drive the Codex CLI by default.** It calls the HTTP Responses API directly.
- A `codex app-server` subprocess runtime exists, but it is opt-in (`api_mode == "codex_app_server"`).
- Source: `H:agent/conversation_loop.py` L1648-1650.

**[C] It reuses the Codex CLI's public OAuth client.** The client id is `app_EMoamEEZ73f0CkXaXp7hrann`, also defined in codex-rs.
- Sources: `H:hermes_cli/auth_constants.py` L93 and `C:codex-rs/login/src/auth/manager.rs` L1784.

**[C] OpenAI now documents an official path for third-party apps: "Sign in with ChatGPT" (SIWC) token sharing.**
- Registration is dynamic: first sign-in uses `client_id=dynamic_agent_client` with `agent_name_hint` and `ext_agent_host_id`. The server then issues a per-app client id `oaiapp_...`.
- Endpoints:
  - authorize: `https://auth.openai.com/api/accounts/authorize`
  - token: `https://auth.openai.com/api/accounts/oauth/token`
  - resource: `https://api.openai.com/v1`
- Plan-usage scopes: `offline_access resource.invoke chatgpt.tokens.use.direct`.
- Redirect URI: must be loopback `127.0.0.1` (example `http://127.0.0.1:1455/auth/callback`). "Don't use `localhost`".
- Inference: `POST https://api.openai.com/v1/responses` with `store:false` and `stream:true`. The docs say to use this public endpoint and not ChatGPT's `backend-api` endpoints.
- Models: `GET https://api.openai.com/v1/models`, filtered on `visibility=="list"`.
- Usage errors: `subscription_sharing_usage_limit_exceeded` (429) and `subscription_sharing_usage_unavailable` (503), possibly delivered as `response.failed`.
- Status: "currently available to selected commercial partners through a limited trial"; plan usage is "open to all open-source partners and selected private clients".
- Sources: the SIWC pages listed above.

**[I] Recommendation for the TS design.** Put the auth and transport behind an interface.
- Treat SIWC (`oaiapp_` client, `api.openai.com/v1/responses`) as the compliant target.
- Treat the Hermes/Codex-client route (`app_EMoam…`, `chatgpt.com/backend-api/codex/responses`) as a compatibility mode that carries ToS and breakage risk.
- The SIWC refresh endpoint and body were not found on the pages fetched **[U]**.
- The rest of this document describes the Hermes route as asked.

---

## 1. OAuth login

### 1a. Device-code flow (Hermes default)

All of the following is **[C]**, from `H:hermes_cli/auth_codex.py` L1000-1131, unless noted.

- **Issuer:** `https://auth.openai.com` (L1110). The client id is `CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` (`auth_constants.py` L93).

**Step 1: request a user code**
- `POST {issuer}/api/accounts/deviceauth/usercode`
- JSON body `{"client_id": "<id>"}`, with `Content-Type: application/json` (L1008-1011).
- On 429, retry up to 4 attempts with backoff `min(Retry-After or 2**attempt, 60)` seconds (L1006-1021).
- On 200, the response contains `device_auth_id`, `user_code`, and `interval`. `interval` is a string; Hermes clamps it to at least 3 and defaults it to 5 (L1026-1028).
- codex-rs accepts both `user_code` and `usercode`, and parses `interval` from a string (`C:codex-rs/login/src/device_code_auth.rs` L27-53).
- In codex-rs, a 404 means "device code login is not enabled" (L83-87).
- The user must enable device-code login in ChatGPT security settings (learn.chatgpt.com/docs/auth).

**Step 2: show the user the code**
- Tell the user to open `https://auth.openai.com/codex/device` and enter `user_code` (L1115-1120). codex-rs uses the same URL (`device_code_auth.rs` L175).

**Step 3: poll for authorization**
- `POST {issuer}/api/accounts/deviceauth/token`
- JSON body `{"device_auth_id", "user_code"}`, sent every `interval` seconds.
- 403 or 404 means still pending; give up after 15 minutes.
- Hermes tolerates up to 6 consecutive transport errors (L1032-1075). codex-rs behaves the same way (L100-147).
- The 200 response is `{authorization_code, code_challenge, code_verifier}`. The server generates the PKCE pair (`device_code_auth.rs` L55-60).

**Step 4: exchange the code for tokens**
- `POST https://auth.openai.com/oauth/token`, form-urlencoded:
  - `grant_type=authorization_code`
  - `code=<authorization_code>`
  - `redirect_uri=https://auth.openai.com/deviceauth/callback`
  - `client_id`
  - `code_verifier`
- Source: L1078-1104; codex-rs `device_code_auth.rs` L202-217.
- Hermes retries transport errors twice on these POSTs with a 15 s timeout (L338-355).
- **[C] Caution from codex-rs:** retrying the code exchange after a response timeout can consume the one-time code. codex-rs only retries on connect errors when no redirect was observed (`C:codex-rs/login/src/server.rs` L713-757).

### 1b. Browser PKCE flow (opt-in in Hermes)

All of the following is **[C]**, from `H:hermes_cli/auth_codex_browser.py`.

- **Authorize URL:** `https://auth.openai.com/oauth/authorize` (L33).
- **Hermes scope:** `openid profile email offline_access` (L34).
- **Hermes query parameters** (L81-85):
  - `response_type=code`
  - `client_id`
  - `redirect_uri`
  - `scope`
  - `code_challenge` with `code_challenge_method=S256`
  - `id_token_add_organizations=true`
  - `state`
- **Listener:** binds `127.0.0.1:1455`. The redirect URI string is `http://localhost:1455/auth/callback`, described as "fixed by the public Codex client registration" (L3-8, L35-38, L122-125).
- **Timeout:** 300 s (L39).
- **Port busy:** falls back to the device-code flow (L62-78).
- **Checks:** validates `state` with a constant-time compare (L154-157).
- **Exchange:** same token POST as above, with the loopback `redirect_uri` (L88-107).

**[C] What codex-rs does today (it differs):**
- Redirect URI is `http://127.0.0.1:{port}/auth/callback` (`server.rs` L194).
- Default port 1455, fallback port 1457 ("Keep in sync with the Codex CLI Hydra redirect URI allow-list") (L78-80).
- Scope is `openid profile email offline_access api.connectors.read api.connectors.invoke`.
- Extra parameters: `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<originator>`, and optional `allowed_workspace_id` (L576-608).

**[I]** Both `localhost` and `127.0.0.1` currently work for the Codex client. Hermes ships `localhost` and codex-rs ships `127.0.0.1`. For a new client, prefer `127.0.0.1`.

### 1c. Tokens returned

- **[C]** The token endpoint returns `id_token`, `access_token`, and `refresh_token`. codex-rs `ExchangedTokens` requires all three (`server.rs` ~L689-693).
- **[C] Claims location.** Claims sit under the JWT claim key `https://api.openai.com/auth`:
  - `chatgpt_account_id`
  - `chatgpt_plan_type`
  - `chatgpt_user_id` / `user_id`
  - `chatgpt_account_is_fedramp`
  - optionally `chatgpt_data_residency` / `chatgpt_compute_residency`
  - Email may also appear under `https://api.openai.com/profile`.
  - Sources: `C:codex-rs/login/src/token_data.rs` L85-133; `H:agent/codex_headers.py` L54-81.
- **[C] Where the account id comes from:**
  - codex-rs takes `account_id` from the **id_token** claims (`server.rs` L851-856).
  - Hermes reads `chatgpt_account_id` from the **access_token** JWT (`codex_headers.py` L72-75) and never stores the id_token.
  - **[I]** Therefore the access token carries the same claim block.
- **[C] codex-rs API-key exchange (optional).** codex-rs can trade the id_token for an API key: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange&requested_token=openai-api-key&subject_token=<id_token>&subject_token_type=urn:ietf:params:oauth:token-type:id_token` (`server.rs` L1017-1050). Hermes does not use this.

### 1d. Hermes storage: `~/.hermes/auth.json`

All **[C]**.

- **Path:** `get_hermes_home()/auth.json` (`H:hermes_cli/auth.py` L492-503). Lock file is `auth.lock` (L720-731).
- **Write:** atomic, mode 0600, parent directory 0700 (L787-813).
- **Top-level schema:** `{version: 1, providers: {...}, active_provider, credential_pool: {...}, updated_at}` (`auth_constants.py` L51; `auth.py` L736, L796-801).
- **Codex entry:** `providers["openai-codex"] = {tokens: {access_token, refresh_token}, last_refresh: "<ISO Z>", auth_mode: "chatgpt", label?, last_auth_error?}` (`auth_codex.py` L197-214).
- **Login result shape:** `{"tokens": {access_token, refresh_token}, base_url, last_refresh, auth_mode: "chatgpt", source: "device-code" | "loopback_pkce"}` (L1126-1131; browser L164-169).
- **Credential pool entries** (`credential_pool["openai-codex"][]`): `id, label, auth_type, priority, source ("device_code" | "manual:device_code" | …), access_token, refresh_token, last_status ("ok" | "exhausted" | "dead"), last_status_at, last_error_code, last_error_reason, last_error_message, last_error_reset_at, base_url, last_refresh, request_count, model_cooldowns, …` (`H:agent/credential_pool.py` L208-241).
- **Design note:** Hermes deliberately keeps its own session separate from `~/.codex/` "so one app's refresh-token rotation cannot invalidate the other's session" (`auth_codex.py` L1-5).

### 1e. Importing from `~/.codex/auth.json`

All **[C]**.

- **Read rule:** reads `$CODEX_HOME/auth.json` (default `~/.codex`) and uses only `.tokens.access_token` and `.tokens.refresh_token`, and only if the access token is not expired. It never writes there (`auth_codex.py` L567-586).
- **Interactive offer:** at login, Hermes asks "Import these credentials? (a separate login is recommended) [y/N]" (L960-972).
- **Automatic adoption:** gated by `auth.adopt_external_logins`. It happens when the stored refresh token is rejected or tokens are missing.
  - It is compare-and-swap against the access token observed under lock.
  - It is refused if the CLI login belongs to a different ChatGPT workspace (L217-256, L545-558, L631-637).
- **Codex `auth.json` fields** (`C:codex-rs/login/src/auth/storage.rs` L49-73; `token_data.rs` L10-41):
  - top level: `auth_mode`, `OPENAI_API_KEY`, `tokens`, `last_refresh`, `agent_identity`, `personal_access_token`, `bedrock_api_key`, `bedrock_access_keys`
  - `tokens`: `id_token`, `access_token`, `refresh_token`, `oauth_provenance{issuer, client_id}`, `login_owner_id`, `account_id`
  - On disk, `id_token` is the raw JWT string (it has a custom serializer).

---

## 2. Token refresh

All **[C]** unless labelled.

**Endpoint and request**
- `POST https://auth.openai.com/oauth/token` (`auth_constants.py` L94; codex-rs `manager.rs` L223).
- **Hermes body:** form-urlencoded `grant_type=refresh_token&refresh_token=…&client_id=app_EMoam…`, with headers `Accept: application/json` and `User-Agent: hermes-cli/<ver>`. Timeout is 20 s (env `HERMES_CODEX_REFRESH_TIMEOUT_SECONDS`) (`auth_codex.py` L482-519).
- **codex-rs body:** JSON (`TokenEncoding::Json`) `{"grant_type":"refresh_token","client_id":…,"refresh_token":…,"refresh_reason":"proactive_expiry" | "scheduled" | "unauthorized_recovery" | "forced"}` (`manager.rs` L1695-1747; `C:codex-rs/login/src/oauth/client.rs` L47-63, L97-135).
- **[I]** The endpoint accepts both encodings.

**Response handling**
- The response contains `access_token` and may contain a new `refresh_token` and `id_token`. Hermes keeps the old refresh token if no new one is returned (L513-519). codex-rs `RefreshResponse` has all three as optional (L1777-1782).

**When to refresh**
- Hermes refreshes when the access-token JWT `exp` is within 120 s (`CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS`) (`auth_constants.py` L96; `auth_codex.py` L65-67, L675-689).
- codex-rs refreshes when `exp` is within 5 minutes, or when `last_refresh` is older than 8 days (`manager.rs` L214-215, L3311-3328).
- On a 401 from a model call, codex-rs first reloads `auth.json` from disk (only if the account id matches), then refreshes, then gives up (L1925-1937).
- Hermes force-refreshes on 401 via `_try_refresh_codex_client_credentials`, and refuses to silently swap to a different account (`H:agent/client_lifecycle.py` L570-595).

**Rotation and single use**
- Refresh tokens are "single-use with rotation-family reuse detection"; replaying a consumed refresh token makes OpenAI revoke the whole family (`auth_codex.py` L180-185, L525-529).
- **Error codes:**
  - Hermes: `refresh_token_reused` produces the message "Codex refresh token was already consumed by another client" (L468-473).
  - codex-rs maps `refresh_token_expired` to Expired, `refresh_token_reused` to Exhausted, and `refresh_token_invalidated` to Revoked.
  - codex-rs treats as Permanent: any 401, those three codes, and a 400 with `invalid_grant`. Everything else is Transient (`manager.rs` L1729-1774).

**Hermes error classification** (`auth_codex.py` L443-479)
- It parses both error shapes: OpenAI `{"error":{code,message,type}}` and OAuth `{"error":"…","error_description":"…"}`.
- `relogin_required` is set if the code is `invalid_grant`, `invalid_token`, `invalid_request`, or `refresh_token_reused`, or if the status is 401 or 403.
- 429 on refresh is a quota error with code `codex_rate_limited`, `relogin=false`, and an optional Retry-After (L498-502, L433-440).
- A 200 response with non-JSON is not a relogin (L505-512).

**Terminal errors (quarantine)**
- Terminal codes: `{invalid_grant, invalid_token, refresh_token_reused, codex_refresh_failed, codex_auth_missing_refresh_token}`, counted only when `relogin_required` is true (`auth.py` L1965-1971, L1982-1985, L2004-2005).
- On a terminal refresh error with no newer tokens on disk, the pool does three things (`credential_pool.py` L1781-1799, L1833-1879):
  1. `_clear_terminal_tokens_state` pops `access_token` and `refresh_token` from `providers.openai-codex.tokens`, but only if the stored refresh token still equals the failed one. It writes `last_auth_error {provider, code, message, reason: "credential_pool_refresh_failure", relogin_required: true, at}`.
  2. It drops singleton-seeded `device_code` pool rows.
  3. It marks remaining rows `last_status: "dead"`.
- Dead rows never re-enter rotation; only a fresh login clears them (L80-98).
- 401 reasons treated as terminal: `token_invalidated`, `token_revoked`, `invalid_token`, `invalid_grant`, `unauthorized_client`, `refresh_token_reused`. `token_expired` stays refreshable (L89-97, L1164-1180).
- Documented behaviour: `H:website/docs/integrations/providers.md` L96.

**Concurrency across processes**
- **Lock primitive:** an advisory `flock(LOCK_EX|LOCK_NB)` on `auth.lock` (msvcrt on Windows), polled every 50 ms. It is reentrant per thread and stamps the holder's PID. Default timeout is 15 s (`AUTH_LOCK_TIMEOUT_SECONDS`) (`auth.py` L593-598, L661-731; `auth_constants.py` L52).
- **Refresh under the lock** (`auth_codex.py` L522-564, L681-689):
  1. Take the lock with timeout `max(15, refresh_timeout + 5)`.
  2. Re-read the store.
  3. If the stored refresh token differs from the one in hand, a peer already rotated it: adopt the stored pair without POSTing.
  4. Otherwise POST, then write the new pair inside the same lock.
  5. If the grant came from a root profile, write it back to that root store.
- **Persist failure:** if the rotated pair cannot be persisted, the old refresh token is already spent. This is treated as terminal: `credential_persist_failed` (`credential_pool.py` L99-104).
- **codex-rs:** uses an in-process `refresh_lock` with "guarded reload"; queued callers reuse a completed refresh (`manager.rs` L3108-3135). No cross-process file lock was found in `storage.rs` **[I/U]**.

---

## 3. Model call (Hermes route)

### Endpoint

- **[C]** `POST https://chatgpt.com/backend-api/codex/responses`. The OpenAI Python SDK is used with `base_url=https://chatgpt.com/backend-api/codex` and `api_key=<access_token>`; the call is `client.responses.create(**kwargs, stream=True)` (`H:agent/codex_runtime.py` L1229-1241).
- **[C]** codex-rs posts to `"/responses"` with `Accept: text/event-stream` (`C:codex-rs/codex-api/src/endpoint/responses.rs` L123-150), using base `CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"` (`C:codex-rs/model-provider-info/src/lib.rs` L82).
- Override: env `HERMES_CODEX_BASE_URL` (`auth_codex.py` L70-71).

### Headers

All **[C]**, from `H:agent/codex_headers.py` L34-81, plus SDK defaults.

| Header | Value / source | Notes |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | Set by the SDK from `api_key`. codex-rs `BearerAuthProvider` (`C:codex-rs/model-provider/src/bearer_auth_provider.rs` L31-47). |
| `ChatGPT-Account-ID` | JWT `https://api.openai.com/auth`.`chatgpt_account_id` | Same casing in codex-rs. Without it, the `/models` catalog returns `{"models":[]}` (`H:hermes_cli/codex_models.py` L173-176). |
| `x-openai-internal-codex-residency` | `chatgpt_data_residency` or `chatgpt_compute_residency` claim | Without it, residency-enforced workspaces return 401 "Workspace is not authorized in this region". codex-rs constant: `model-provider-info/src/lib.rs` L43. |
| `X-OpenAI-Fedramp` | `true` if `chatgpt_account_is_fedramp` | Sent by codex-rs only; Hermes does not send it. |
| `originator` | `hermes-agent` (official host); `codex_cli_rs` for custom proxies | codex-rs default `DEFAULT_ORIGINATOR = "codex_cli_rs"` (`C:codex-rs/login/src/auth/default_client.rs` L42). |
| `User-Agent` | `HermesAgent/<version>` (official host); `codex_cli_rs/0.0.0 (Hermes Agent)` for proxies | codex-rs format: `{originator}/{ver} ({os} {ver}; {arch}) …` (default_client.rs ~L148-160). |
| `session_id` | Hermes session id (underscore form) | `H:agent/transports/codex.py` L859-868. codex-rs sends `session-id` and `thread-id` (hyphen form) (`C:codex-rs/codex-api/src/requests/headers.rs` L5-14). |
| `x-client-request-id` | Mirrors `prompt_cache_key` | Hermes L862-865. codex-rs sends `thread_id` (`core/src/client.rs` L1428-1431). |
| `Content-Encoding: zstd` | Optional; zstd-compressed body on `/responses` to the official host | `codex_headers.py` L84-115 (parity with openai/codex#10102). |
| `OpenAI-Beta` | **Not sent** by Hermes on HTTP | codex-rs sets `OpenAI-Beta` only for the websocket transport (`RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE`) (`core/src/client.rs` L1441-1444). |
| codex-only extras | `x-codex-turn-state` (sticky routing; replay within a turn), `x-codex-beta-features`, `x-codex-installation-id`, `x-oai-attestation`, `x-openai-subagent` | `core/src/client.rs` L161-170, L2494-2511. Hermes sends none of these. |

**[C] Identity requirement.** Hermes docs: "OpenAI requires third-party Codex harnesses to identify themselves. ChatGPT-authenticated requests to the official Codex endpoint automatically send `originator: hermes-agent` and `User-Agent: HermesAgent/<version>`" (`H:website/docs/user-guide/configuration.md` L2472-2479). No OpenAI primary source for this rule was found **[U]**. **[I]** Send your own originator string; do not impersonate `codex_cli_rs`.

### Request body

Built by `ResponsesApiTransport.build_kwargs` (`H:agent/transports/codex.py` L716-889) and validated by `_preflight_codex_api_kwargs` (`H:agent/codex_responses_adapter.py` L1016-1078). All **[C]**.

```json
{
  "model": "gpt-5.5",
  "instructions": "<system prompt; falls back to DEFAULT_AGENT_IDENTITY if empty>",
  "input": [ ...items... ],
  "store": false,
  "stream": true,
  "tools": [{"type":"function","name":"…","description":"…","strict":false,"parameters":{…}}],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {"effort":"medium","summary":"auto"},
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "pck_<sha256[:24]>",
  "text": {"verbosity":"…"},
  "service_tier": "…"
}
```

The `text` and `service_tier` fields are optional.

**Fields that must be present or set a certain way**
- `model`, `instructions`, and `input` are mandatory, and `store` must be `false`. Hermes raises an error before sending otherwise (L1022-1043).
- `tools` must be omitted when empty (codex.py L786-790).
- On the codex backend, Hermes does **not** send `max_output_tokens` (codex.py L859-870).
- `prompt_cache_retention` is stripped because it causes HTTP 400 (`codex_runtime.py` L1121-1142).
- The allowed key set is whitelisted (`codex_responses_adapter.py` L985-1006).

**`instructions`**
- **[C]** Hermes sends its own system prompt, not Codex's prompt, and preflight requires the field to be non-empty.
- **[C]** codex-rs no longer sends a top-level `instructions` field at all. Its `ResponsesApiRequest` has no such field; base instructions go in as a prefix input message with id `msg_<uuidv5>` (`C:codex-rs/codex-api/src/common.rs` L279-304; `C:codex-rs/core/src/client.rs` L1031-1040).
- **[I]** The backend does not currently validate an instructions prefix (Hermes works with arbitrary instructions). Older community folklore that `instructions` must equal the Codex prompt appears stale.
- **[U]** No server-side contract for this is documented.

**Input item shapes** (`codex_responses_adapter.py` L591-729)
- user: `{"type":"message","role":"user","content":[{"type":"input_text","text":"…"}]}`
- assistant text: `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"…"}], "status":"completed", "phase"?, "id"?}`
- tool call: `{"type":"function_call","call_id":"call_…","name":"…","arguments":"<json string>"}`
- tool result: `{"type":"function_call_output","call_id":"call_…","output":"<string>"}`. `output` may also be an `input_text`/`input_image` parts array.
- reasoning replay: `{"type":"reasoning","encrypted_content":"…","summary":[{"type":"summary_text","text":"…"}]}`, with `id` stripped because `store:false` lookups return 404 (L467-504).

**Backend quirks** (all **[C]**)
- The codex backend rejects string `content` with 400 `{"detail":"Unsupported content type"}`. Always use typed parts (L662-666, issue #51512).
- Assistant message ids that do not start with `msg` are dropped for the codex backend (L453-464).
- A `msg_*` id whose turn carried reasoning must be dropped, or the request fails with 400 "provided without its required 'reasoning' item" (L507-537).
- `call_id` is capped at 64 characters; longer ids get a hashed surrogate `call_<sha256[:32]>` (L346-351).
- Duplicate `call_id` values across turns cause 400 "Duplicate function_call_output". Rewrite them to `_dup<n>` on the wire (L540-566).
- The tool name `tool_search` is reserved on OpenAI/chatgpt.com; alias it to `hermes_tool_search` (codex.py L95-99, L281-283).
- A client-side `web_search` collides with the native `{"type":"web_search"}` tool (codex.py L250-256).

**Reasoning**
- Default effort is `medium`, clamped to the model's supported ladder.
- `summary:"auto"` is always sent when reasoning is enabled; `{"effort":"none"}` is sent to disable it.
- `reasoning.context:"all_turns"` is never sent to the codex backend (codex.py L293-343, L584-635).

### Streaming SSE

The standard Responses events; Hermes assembles the response itself. All **[C]**, from `H:agent/codex_runtime.py` L783-1118.

- `response.created` (codex-rs reads the id), `response.in_progress`
- `response.output_item.added`: announces an item, including `function_call` with `id`, `call_id`, and `name`
- `response.output_text.delta` / `.done`
- `response.function_call_arguments.delta` / `.done`
- `response.reasoning_summary_text.delta` (with `summary_index`), `response.reasoning_text.delta`, `response.reasoning_summary_part.added`
- `response.refusal.delta`
- `response.output_item.done`: authoritative item
- Terminal: `response.completed`, `response.incomplete` (with `incomplete_details.reason`), `response.failed` (with `response.error`)
- `error` frames carry top-level or nested `code`, `message`, and `param`.
- codex-rs list: `C:codex-rs/codex-api/src/sse/responses.rs` L345-506. codex-rs also treats `codex.rate_limits` events as rate-limit snapshots (`C:codex-rs/codex-api/src/rate_limits.rs` L120-170).

**Assembly rules (Hermes)**
- Build `output` from the `output_item.done` items. **Do not** rely on `response.completed.response.output`, which can be null or empty (L784-786, L1075-1089).
- Settle `function_call` items that were announced but never got a `.done`.
- Use `output_index` order when every item has one; otherwise use wire order.
- **[C]** A codex reasoning-only response with `status:"completed"` is treated as "incomplete", and a continuation is requested (`codex_responses_adapter.py` L1293-1311).

### Models

- **[C] Live catalog:** `GET {base}/models?client_version=99.0.0`, falling back to `?client_version=0.0.0`, with headers `Authorization` and `ChatGPT-Account-ID`. Omitting `client_version` gives HTTP 400.
  - The response is `{models:[{slug, priority, visibility, supported_in_api, minimal_client_version, …}]}`.
  - Filter out `visibility` values `hide`/`hidden` and sort by `priority`.
  - Sources: `H:agent/model_metadata.py` L1756-1816; `H:hermes_cli/codex_models.py` L136-182.
- **[C] Hermes offline fallback list** (the ChatGPT-account backend rejects `-pro` variants and retired codex slugs with 400 "not supported when using Codex with a ChatGPT account"):
  - `gpt-6-sol`, `gpt-6-luna`
  - `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
  - `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.4`
  - `gpt-5.3-codex-spark` (Pro only)
  - Source: `codex_models.py` L16-35.
- **[C]** Most models have a 272K context window on this route (`model_metadata.py` L1662-1666).

---

## 4. Tool loop

- **[C] Stateless replay.** Hermes rebuilds the full `input` from its chat history on every call (`store:false`) and never uses `previous_response_id`; a grep across `agent/` and `run_agent.py` found no usage. codex-rs HTTP requests also use `store:false`, and its websocket request sets `previous_response_id: None` in the `From<&ResponsesApiRequest>` conversion (`common.rs` L306-311).
- **[C] Per iteration:**
  1. Build kwargs.
  2. Stream.
  3. Normalize the result. A `function_call` becomes a `ToolCall{id: call_id, name, arguments}`, with `finish_reason="tool_calls"` (`codex_responses_adapter.py` L1123-1135, L1299-1300).
  4. Execute the tools.
  5. Append an assistant message with `tool_calls`, plus encrypted reasoning items (`codex_reasoning_items`) and the exact message items (`codex_message_items`).
  6. Append tool messages; these become `function_call_output` items with the same `call_id`.
  7. Repeat until `finish_reason == "stop"`.
- **[C] Incomplete turns:** a turn that ends incomplete (reasoning-only, leaked `to=functions.x` text, or `response.incomplete`) is continued up to 3 times. The continuation adds a nudge user message and boosts the output cap (`H:agent/turn_truncation.py` ~L660-673; leak detection at `codex_responses_adapter.py` L1258-1270).
- **[C] Transport retry:** one physical stream retry on connect or mid-stream transport errors (`max_stream_retries = 1`, `codex_runtime.py` L1152, L1380-1410).
- **[C] 400 `invalid_encrypted_content`:** first drop unverified reasoning blobs; on a repeat, disable reasoning replay for the session (codex.py L666-678; adapter L611-620).
- **[C] Rate-limit and quota shapes on this backend:**
  - HTTP 429 with body `{"error":{"type":"usage_limit_reached","plan_type":"…","resets_at":<epoch s>,"limit_window_minutes":…}}`. `resets_in_seconds` also appears.
  - Other 429 types: `usage_not_included`, `insufficient_quota`.
  - Rate-limit headers: `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, the `x-codex-secondary-*` equivalents, `x-codex-promo-message`, and `x-codex-rate-limit-reached-type`.
  - Sources: `C:codex-rs/codex-api/src/api_bridge.rs` L185-232, L344-356; `rate_limits.rs` L190-215, L280-320; `H:agent/agent_runtime_helpers.py` L3664-3690.
- **[C] Hermes on 429:** `usage_limit_reached` benches the credential until `resets_at` and rotates the pool (`agent_runtime_helpers.py` L990-1003).
- **[C] Usage probe:** `GET https://chatgpt.com/backend-api/wham/usage` returns `rate_limit.{primary_window, secondary_window}.used_percent` and `additional_rate_limits[]` (`auth_codex.py` L721-788).
- **[U]** Hermes's main-loop maximum iteration count was not verified. The `max_iterations: 250` found in config belongs to the `delegation` section.

---

## 5. Constraints and risks

- **[C] Policy:**
  - OpenAI's public auth page covers only Codex clients and says nothing about third-party harnesses using the Codex client id (learn.chatgpt.com/docs/auth).
  - The sanctioned third-party route is SIWC, which uses its own client id, `api.openai.com`, and an explicit "not backend-api" rule (see §0).
  - Hermes's docs say plan-tier eligibility and quota accounting are "not currently documented" (`providers.md` L144-150).
- **[C] Known breakages Hermes has patched:**
  - #51512: string content rejected.
  - #52492: dead model slugs.
  - #97427: msg/reasoning id pairing.
  - #102629: duplicate call ids.
  - #119412: `client_version=0.0.0` started returning a frozen catalog after the GPT-6 rollout, so Hermes now sends `99.0.0`.
  - #106384: OpenSSL 3.5 post-quantum ClientHello rejected by middleboxes.
  - Residency 401s.
  - #87503: refresh-family revocation across profiles.
- **[I] Version coupling:** Hermes does not depend on Codex CLI releases. It tracks the backend contract by mirroring codex-rs behaviour (headers, zstd, catalog `client_version`) and by reacting to issues. The live catalog endpoint gates models by `minimal_client_version`.
- **[I] Upstream drift risk:**
  - codex-rs is moving to websockets (`OpenAI-Beta` responses_websockets v2), base instructions as input items, and attestation headers (`x-oai-attestation`).
  - The HTTP path still exists in codex-rs (`endpoint/responses.rs`), but OpenAI could tighten it or require attestation.
- **[I] Refresh-token rotation risk:** sharing tokens with the Codex CLI causes `refresh_token_reused`. Do your own login; import only as a fallback.

---

## 6. TypeScript sketch outline (not full code)

```ts
// constants (from source)
const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";            // Codex CLI public client (compat mode)
const TOKEN_URL = `${ISSUER}/oauth/token`;
const DEVICE_USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_VERIFY_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;           // browser PKCE
const BROWSER_SCOPE = "openid profile email offline_access";
const BROWSER_REDIRECT = "http://127.0.0.1:1455/auth/callback"; // codex-rs; Hermes uses localhost
const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const REFRESH_SKEW_S = 120;   // Hermes (codex-rs: 300)
const LOCK_TIMEOUT_S = 15;
const AUTH_CLAIM = "https://api.openai.com/auth";
// SIWC (compliant mode): dynamic_agent_client -> oaiapp_*, scopes "offline_access resource.invoke chatgpt.tokens.use.direct",
// authorize /api/accounts/authorize, token /api/accounts/oauth/token, inference https://api.openai.com/v1/responses

// 1. device login
async function deviceLogin(): Promise<Tokens> {
  // POST DEVICE_USERCODE_URL {client_id} (JSON); 429 => backoff min(RetryAfter ?? 2**n, 60), 4 tries
  // -> {device_auth_id, user_code, interval(str)}; interval = max(3, +interval || 5)
  // print DEVICE_VERIFY_URL + user_code
  // loop every interval up to 15 min: POST DEVICE_TOKEN_URL {device_auth_id, user_code}; 403/404 => pending
  // -> {authorization_code, code_verifier}
  // POST TOKEN_URL form {grant_type:"authorization_code", code, redirect_uri: DEVICE_REDIRECT_URI, client_id, code_verifier}
  //   (retry only on connect errors, never after the request may have reached the server)
  // -> {id_token, access_token, refresh_token}; accountId = jwt(access_token)[AUTH_CLAIM].chatgpt_account_id
}

// 2. token store with refresh + cross-process lock
interface StoreFile { version: 1; providers: { "openai-codex"?: { tokens: { access_token: string; refresh_token: string; id_token?: string };
  last_refresh: string; auth_mode: "chatgpt"; last_auth_error?: {...} } } }
// file 0600 under 0700 dir; atomic write (tmp + rename + fsync dir); lock = flock on auth.lock
// (node: proper-lockfile or fs-ext flock), poll 50 ms, timeout max(15, refreshTimeout + 5)
async function getAccessToken(force = false): Promise<string> {
  // read; if !force && exp > now + REFRESH_SKEW_S -> return
  // withLock: re-read; if stored.refresh_token !== inHand.refresh_token -> adopt stored (peer rotated)
  //   POST TOKEN_URL form {grant_type:"refresh_token", refresh_token, client_id}
  //   200 -> save {access_token, refresh_token: new ?? old} BEFORE releasing lock (persist failure = terminal)
  //   429 -> RateLimited(retryAfter), keep tokens
  //   401/403 or code in {invalid_grant, invalid_token, refresh_token_reused, refresh_token_expired,
  //     refresh_token_invalidated} -> quarantine: drop tokens if still equal, set last_auth_error, require relogin
  //   other -> transient
}

// 3. one streaming Responses call
async function* streamResponse(req: {model; instructions; input: Item[]; tools?: FnTool[]; sessionId}) {
  const at = await getAccessToken(); const c = jwt(at)[AUTH_CLAIM] ?? {};
  // POST `${CODEX_BASE}/responses`, headers: Authorization Bearer, ChatGPT-Account-ID: c.chatgpt_account_id,
  //  x-openai-internal-codex-residency (if claim), originator: "<your-app>", User-Agent: "<YourApp>/<ver>",
  //  session_id, Accept: text/event-stream, Content-Type: application/json
  // body: {model, instructions, input, store:false, stream:true, tools?, tool_choice:"auto", parallel_tool_calls:true,
  //        reasoning:{effort:"medium", summary:"auto"}, include:["reasoning.encrypted_content"], prompt_cache_key}
  // parse SSE; collect output_item.done items; deltas -> UI; terminal = completed|incomplete|failed; "error" frame -> throw
  // 401 once -> getAccessToken(true) and retry; 429 usage_limit_reached -> surface resets_at
}

// 4. tool loop (stateless replay)
async function runLoop(history: Item[], tools) {
  for (let i = 0; i < MAX_ITERS; i++) {
    const out = await collect(streamResponse({..., input: history}));
    history.push(...out.filter(isReasoning).map(stripId), ...out.filter(isMessage), ...out.filter(isFunctionCall));
    const calls = out.filter(isFunctionCall);
    if (!calls.length) { if (reasoningOnlyOrIncomplete(out) && cont++ < 3) continue; return out; }
    for (const fc of calls) history.push({type:"function_call_output", call_id: fc.call_id,
      output: await run(fc.name, JSON.parse(fc.arguments || "{}"))});
  }
}
// invariants: typed content parts only; call_id <= 64 chars & unique per request; drop msg ids paired with reasoning;
// never send max_output_tokens / prompt_cache_retention to codex backend; alias tool_search.
```

### Open items [U]

- SIWC refresh endpoint and body.
- Whether chatgpt.com will start requiring attestation for HTTP clients.
- Any OpenAI primary source for the "third-party harnesses must identify themselves" originator rule.
- Hermes's main-loop iteration cap.
