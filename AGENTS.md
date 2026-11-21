# Ungate — architecture and project structure

## Purpose

Ungate is a Cursor extension that lets you use Claude, ChatGPT, and MiniMax subscriptions instead of paying for API tokens. It consists of a VS Code extension, a local HTTP proxy (Fastify), a Svelte WebUI, and a shared types/constants library. The primary user value is using a subscription through Cursor's native chat, not exposing a generic proxy for arbitrary providers.

Scope: one monorepo with the extension, proxy, and web UI. Tunnel integration is part of the product because Cursor cannot reach `localhost` from its backend. Hosted deployment, custom domains, and external key-management infrastructure are out of scope.

## Code style

Prefer OOP with classes over standalone pure functions.

- Put named logic on classes: instance classes for stateful units, all-static classes for helpers and facades.
- One class per file. Do not mix static and instance methods on the same class.
- Do not add module-level helper functions (`function foo`, `export function bar`). Exceptions: VS Code `activate` / `deactivate` entrypoints.
- Prefer self-documenting names and structure over comments.

## Monorepo (pnpm workspace)

```
ungate/
├── apps/
│   ├── api/          # Local proxy server (Fastify + TypeScript)
│   ├── extension/    # VS Code / Cursor extension
│   └── web/          # Web UI (dashboard) in Svelte
├── packages/
│   ├── shared/       # Shared types, schemas, constants, helpers
│   └── dev-kit/      # Linter, vitest configs
└── scripts/          # Utilities (build, tunnel, check-tunnels)
```

## Data flow

Cursor → Cloudflare Tunnel → Ungate API → Provider API. Cursor cannot call localhost, so a public tunnel URL is required. Ungate listens on a custom OpenAI Base URL, transforms requests into the target provider format and back.

## apps/api — proxy server

Fastify v5 server, spawned by the extension as a child Node.js process. CORS is handled globally via `@fastify/cors`. Both the extension and the API are bundled with `tsup` (CJS) — production entry point is `bundle/main.cjs`, dev entry point is `dist/main.js`.

**Entry points:**
- `/v1/chat/completions` — OpenAI-compatible endpoint, accepts requests from Cursor
- `/v1/messages` — Anthropic-compatible endpoint (direct proxy)
- `/analytics` — request statistics; `/analytics/insights?period=` — usage insights (token mix, account pool, sessions, rotations, continuations)
- `/auth/*` — OAuth and account routes (Claude, ChatGPT, Gemini, MiniMax, Cursor), mounted without a `/v1` prefix (only the Cursor routes are also served under `/v1/auth/cursor/*`)
- `/v1/models` — model list
- `/settings` — settings

**Architecture:**
- `src/server.ts` — Fastify initialization, plugin registration
- `src/config.ts` — static configuration (URLs, OAuth, beta parameters)
- `src/plugins/auth.ts` — preHandler for API-key authentication

**Routing (`src/routes/`):**
- `openai.ts` — main router: determines provider by model (MiniMax → mapped → Claude). Branch order matters and must stay consistent.
- `anthropic.ts` — direct proxy to Anthropic API with OAuth token
- `analytics.ts`, `auth.ts`, `health.ts`, `models.ts`, `settings.ts`

**Provider selection (`src/orchestration/openai/model-routing.ts`):**
- MiniMax: model name prefix or `model_mappings` entry pointing to MiniMax upstream
- OpenAI-mapped: `model_mappings` entry pointing to OpenAI (ChatGPT Codex)
- Claude (Anthropic): default fallback path
- Each model ID maps to one provider (configured per-row in `model_mappings`), not a global setting.

**Proxy clients (`src/proxy/`):**
- `anthropic-client.ts` — requests to Anthropic Claude Code API via OAuth. Tool name mapping (Cursor → Claude Code), 401 retry with token refresh, 400 error diagnostics, logging for rare `illegal value` errors
- `openai-client.ts` — requests to ChatGPT Codex API (`/responses`). Streaming format converter for both `function_call` and `custom_tool_call` variants
- `minimax-client.ts` — requests to MiniMax API
- `proxy-client.ts` — wrapper
- `tool-mapper.ts` — bidirectional tool name mapping (Cursor ↔ Claude Code)
- `request-builder.ts` — request body preparation for Claude Code (headers, stainless headers, beta params)

**OpenAI orchestration (`src/orchestration/openai/`):**
- `model-routing.ts` — provider determination by model ID
- `provider-handlers/` — handlers for Claude, OpenAI, MiniMax
- `streaming-gateway.ts` — stream management
- `error-mapper.ts`, `error-messages.ts` — error mapping to OpenAI format

**Adapters (`src/adapter/`):**
- `anthropic-to-openai.ts` — Anthropic response → OpenAI format conversion (including streaming tool calls)
- `openai-to-anthropic.ts` — OpenAI request → Anthropic conversion
- `xml-tool-parser.ts` — XML tool use parsing

**Streaming (`src/streaming/`):**
- `openai-stream-handler.ts` — reverse tool name mapping in streams
- `minimax-stream-handler.ts` — MiniMax streaming with `<think>`/`</think>` tag parsing (split tags across chunks via `pendingTag` state)

**Codex responses (`src/proxy/responses-stream-mapper/`):**
- SSE stream parsing from ChatGPT Codex `/responses` into OpenAI chat.completion.chunk
- Handles both streaming variants: `function_call` + `response.function_call_arguments.*` and `custom_tool_call` + `response.custom_tool_call_input.*`
- `stream-state.ts`, `stream-openai-chunks.ts`, `responses-event-router.ts`, `stream-assistant-text.ts`, `process-responses-chunk.ts`, `stream-diagnostics.ts`

**Codex input normalization (`src/proxy/responses-input-normalizer/`):**
- OpenAI chat completion → Codex `/responses` payload transformation
- `input-shape.ts`, `build-body.ts`, `input-text.ts`, `resolve-model.ts`, `types.ts`

**Subscription usage (`src/usage/`):**
- `usage-parsers.ts` — pure parsers for Claude `GET /api/oauth/usage` (`five_hour`/`seven_day[_<model>]`, utilization 0–100), `anthropic-ratelimit-unified-<window>-utilization` headers (0–1 fraction), ChatGPT `GET /backend-api/wham/usage` (`rate_limit.{primary,secondary}_window`) and `x-codex-{primary,secondary}-*` headers
- `usage-store.ts` — `AccountUsageStore`, in-memory per-account cache (not persisted). Updates merge by window id so header updates never drop endpoint-only windows (e.g. `7d_opus`); a window the usage endpoint reports as `null` is dropped
- `usage-fetcher.ts` — `UsageFetcher.refresh(provider, accountId?)`: live fetch per non-needs-login account, one 401 refresh retry, 60 s per-account throttle, in-flight dedupe, 10 s timeout. Never changes cooldowns or needs-login state
- `AccountFallback.run` records rate-limit headers of every upstream attempt; `OAuthAccounts.dto()` exposes `usage`; `POST /auth/:provider/usage/refresh` (`{ accountId? }`) fetches and returns the account list

**Database (`src/database/`):**
- SQLite via Drizzle ORM + better-sqlite3
- Tables: `app_settings` (port, apiKey, quiet, extraInstruction, claudeCliVersionMode, claudeCliVersionCustom), `provider_settings` (per-provider OAuth tokens, refresh tokens, expiry), `model_mappings` (id, label, provider, upstreamModel, reasoningBudget), `requests` (analytics). Since `_0012`, `requests` also stores nullable telemetry: `accountId`, `attempts`, `rotationReason`, `cacheReadTokens`, `cacheCreationTokens`, `reasoningTokens` (Codex), `reasoningChars` (Anthropic/MiniMax thinking text length — an estimate, Anthropic reports no thinking-token count), `reasoningTier`, `stopReason` (`end_turn | tool_use | max_tokens | stop_sequence | error | aborted | unknown`; client cancels record `aborted`), `toolCallCount`, `toolNames` (JSON array), `sessionKey`, `turnIndex`, `messageCount`, `continuation`, `firstTokenMs`. Rows recorded before `_0012` have these as null and the dashboard shows them as "not tracked", not 0. `inputTokens` stays the total input including cache reads/writes
- Insights: `database/insights.ts` (`UsageInsightsQuery`, called by `Analytics.getInsights`) runs grouped raw SQL over `requests` (window functions for continuation causes, `json_each` for tool names); pool balance is `1 − normalized Gini` over per-account tokens of the largest provider pool
- Migrations: `apps/api/drizzle/` — idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`). Generated with `pnpm drizzle-kit generate --name <index>` (config: `prefix: 'none'`); files are named `_0000.sql`, `_0001.sql`, …
- Model registry: `model_mappings` is the single source of truth for model routing. Default models are seeded by migration `_0002.sql` only — there are no runtime defaults in code.
- Databases on disk: `~/.ungate/data.db` (production default) and `~/.ungate/data-dev.db` (used when `DB_PATH=$HOME/.ungate/data-dev.db` is set in dev). Always verify which database the running API process is using before debugging analytics or auth.

**Types (`src/types/`):**
- `openai.ts`, `anthropic.ts`, `anthropic-stream.ts`, `proxy.ts`, `auth.ts`

**Tools (`src/tools/`):**
- `translator.ts` — tool name translation in responses
- `normalizer.ts` — parameter normalization (string→array)

**Metrics (`src/metrics/`):**
- `completion-request-telemetry.ts` — request recording, response headers
- `request-heuristics.ts` — `RequestHeuristics`: pure request-side heuristics computed once in `routes/openai.ts` and carried on `RequestContext.telemetry` to every `Requests.record` site. `sessionKey` = sha256 of the whole first user message (Cursor resends the chat each step; model excluded so model switches stay one session), `turnIndex` = assistant messages in history, `continuation` = short "continue / keep going / …" nudge, or the previous row of the same session ended `max_tokens` / `error` / `aborted`. Also `normalizeStopReason` across Anthropic, Codex and OpenAI values. Sessions and continuations are heuristics, not ground truth
- `index.ts` — barrel export

**Auth (`src/auth/`):**
- OAuth PKCE flow for Anthropic: `startLogin()` generates verifier/challenge, `completeLogin()` exchanges code for tokens. Manual `CODE#STATE` entry required (Anthropic rejects localhost redirect_uri for claude.ai OAuth).

## apps/extension — VS Code extension

User entry point. Manages the API server and tunnel lifecycle.

- `extension.ts` — activate/deactivate
- `extension-controller.ts` — main controller: manages API server, tunnel, WebView dashboard, OpenAI Key Fix, heartbeat, runtime state sync
- `api-server.ts` — start/stop Node.js API as child process. Production: `cp.spawn(runtime, ['bundle/main.cjs'])`. Dev: `cp.spawn('node', ['-r', 'source-map-support/register', 'dist/main.js'])`. Port detected from stdout via `localhost:(\d+)` regex
- `tunnel-manager.ts` — Cloudflare tunnel (cloudflared) management. Quick tunnel only, no named tunnel config (avoids 404 conflicts). Not auto-started, only on explicit user action. Auto-restarts on port change if already running
- `dashboard.ts` — WebView dashboard (Svelte UI). Reads `index.html` from `web/dist/`, rewrites `/assets/` to `vscode-resource:` URIs, injects `window.__PORT__`. Handshake: frontend sends `webview-ready` before extension sends initial state
- `extension-status-bar.ts` — status bar (API + tunnel state)
- `extension-commands.ts` — command registration (openDashboard, copyTunnelUrl, restartTunnel, toggleKeyFix)
- `auto-tunnel.ts` — opt-in auto-start of the tunnel and per-URL "paste this base URL" assist (see Auto tunnel below)
- `openai-key-fix.ts` — auto-enable OpenAI API Key in Cursor settings. Uses `aiSettings.usingOpenAIKey.toggle` command. SQLite writes to `state.vscdb` do not work — Cursor does not re-read reactive storage
- `runtime-state/` — multi-window coordination via file-based state. Windows heartbeat, leader election, command queue

**Native dependencies:**
- better-sqlite3: prebuilt binary downloaded at first run from GitHub Releases matching host Node ABI (not Electron). VSIX ships only JS wrapper + bindings
- cloudflared: binary downloaded to `~/.ungate/bin/`, managed by tsup bundling
- sqlite3 CLI: `sqlite-tools` archive from sqlite.org, used only to read Cursor's `state.vscdb`
- Every download goes through `utils/verified-artifact.ts`: one pinned upstream URL plus a SHA-256 allowlist per platform/arch (and per Node ABI for better-sqlite3). Bytes are hashed while streaming into a staging directory and compared with `timingSafeEqual`; nothing is extracted, copied, chmod-ed or executed before the digest matches, and staging is deleted on failure. Unknown platform/ABI tuples fail closed with an actionable error instead of falling back to a `latest` release
- Pinned sets: better-sqlite3 12.11.1 for Node ABI 127/137/141/147 (Node 22/24/25/26) on glibc Linux, macOS and Windows; cloudflared 2026.8.2; sqlite-tools 3470200 (upstream publishes only `win-x64`, `linux-x64`, `osx-x64` — macOS arm64 and Linux arm64 must supply their own `sqlite3` on PATH)
- Every binary Ungate installs carries a `<binary>.sha256` stamp written after verification: `~/.ungate/bin/` for cloudflared and the sqlite3 CLI, and `better_sqlite3.installed.node` in the API's `node_modules`. A managed binary without a matching stamp is treated as unverified — it is never loaded, executed or handed to the API child, and is replaced by a verified install. This retires binaries left behind by pre-pinning Ungate versions and by the `cloudflared` npm helper's `latest` install. The bundled/dev `better_sqlite3.node` binding shipped in the tree is still load-tested, since it is not a download
- There is no manual drop-in override: on a platform with no pinned artifact the unsupported error says the feature cannot start, rather than pointing at a directory whose unstamped contents would be rejected anyway

**Logs:**
- Two ring buffers (500 entries each): API (stdout/stderr) and tunnel (stderr)
- Health check against `/health` every second, three states: running, stopped, error

## apps/web — Svelte Web UI

Dashboard for managing providers, tunnel, settings.

- Svelte 5 (runes), SvelteKit-like structure
- `src/shared/api.ts` — HTTP client to API
- `src/shared/vscode.ts` — `acquireVsCodeApi()` singleton
- `src/features/settings/` — settings and providers (settings-store, settings-ui-store, provider-store)
- `src/features/auth/` — subscription accounts (account-store, AccountManager, `UsageBars.svelte` for per-account usage windows)
- `src/features/tunnel/` — tunnel management (tunnel-store)
- `src/features/analytics/` — request statistics (analytics-store); `insights/` — usage insights section below the token chart (insights-store follows the analytics period selector; Tokens / Accounts / Agents / Reliability tabs built with LayerChart; stat cards for cache hit rate, tokens per session, continuation rate, pool balance)
- `src/features/logs/` — log viewer (logs-store)

## packages/shared — shared library

Types, constants, Zod schemas, helpers.

- `src/types/` — `settings.ts`, `runtime.ts`, `tunnel.ts`, `analytics.ts`, `log.ts`
- `src/constants/` — `routes.ts`
- `src/enums/` — `common.ts`
- `src/helpers/` — `claude-cli.ts` (`ClaudeCliVersion`), `model-provider.ts`, `provider-labels.ts`, `utils.ts`
- `src/schemas/` — `runtime.ts`
- `src/guards/` — `settings.ts`
- Two entry points: `index.ts` (server-side) and `frontend.ts` (browser-safe subset)

## Key mechanisms

**Claude OAuth authentication:** acquires token via Anthropic OAuth PKCE flow, stores in SQLite. Refreshes token on 401. Anthropic requires Claude Code request fingerprint: `?beta=true` URL suffix, `User-Agent` with `claude-cli/<version> (external, claude-vscode)` (`<version>` from `claudeCliVersionMode` / `claudeCliVersionCustom` in `app_settings`, default stable `2.1.9`, latest `2.1.322`), full `x-stainless-*` headers, `anthropic-dangerous-direct-browser-access: true`, and the Claude Code 2.1.322 `anthropic-beta` list in `apps/api/src/proxy/claude-code-packet.ts`. Reasoning requests also send adaptive thinking with `display: updates`, `output_config.effort`, and `context_management` clear-thinking. Headers built in `RequestBuilder.getClaudeOAuthHeaders()`. Dashboard: Provider → Claude → Claude Code version. Manual `CODE#STATE` entry required — Anthropic does not accept localhost as redirect_uri for claude.ai OAuth.

**System prompt conflict:** Claude Code's system prompt describing tools conflicts with Cursor's actual `input_schema`. The prompt must be minimal — identity only — and delegate tool shape to `input_schema`. The `extraInstruction` field in `app_settings` reinforces this priority. Full removal breaks API contract (empty blocks error), long prompts cause `invalid arguments` on large plans.

**Tool mapping:** Cursor tool names (Shell, LS, StrReplace) are mapped to Claude Code names (Bash, Glob, Edit) on outbound requests and reverse-mapped in responses. Required for Anthropic OAuth whitelist — Anthropic validates tool names server-side and only allows standard Claude Code names. Mapping covers: Bash↔Shell, Read↔Read, Write↔Write, Edit↔StrReplace, Edit↔Delete, Glob↔LS, Grep↔Grep, WebFetch↔WebFetch, WebSearch↔WebSearch.

**Usage limits:** each saved Claude/ChatGPT account card in the dashboard shows its subscription windows (5-hour, weekly, model-specific) with % used and reset time. Two sources feed the in-memory `AccountUsageStore`: rate-limit headers on every proxied response (free, arrive with the 5 s account-list poll) and the providers' usage endpoints (`/api/oauth/usage` for Claude with `anthropic-beta: oauth-2025-04-20`; `/backend-api/wham/usage` for ChatGPT with `chatgpt-account-id`), fetched on dashboard attach/focus, every 5 min while visible, and via "Refresh usage". Usage is display-only, with one narrow exception: it never creates or extends a cooldown and never drives account switching, but a successful endpoint fetch may *lift* an existing cooldown (`usage/upgrade-detector.ts`): `plan_upgraded` when the tier ranks higher than the last one persisted in `oauth_accounts.planType` (Claude tier from `GET /api/oauth/profile`, ChatGPT from `plan_type`), or `usage_available` when the cooldown came from a usage limit and every endpoint window is under 100% (header-only data never lifts). The clear is credential-version aware and never touches needs-login. Entering a cooldown triggers one throttled refresh so an upgrade is noticed quickly; `POST /auth/:provider/accounts/:id/clear-cooldown` ("Clear cooldown" on the account card) is the manual override. Usage windows are lost on API restart and refilled by the next refresh.

**Usage insights:** every proxied completion records per-request telemetry (account + fallback attempts, cache split, reasoning, stop reason, tool calls, TTFT, inferred session/turn/continuation) into `requests`. Account data comes from `AccountFallback.run` outcomes (`accountId`, `attempts`, `rotationReason`); stream-side data from `OpenAIStreamHandler` (Anthropic `message_start` / `message_delta` / `tool_use` / `thinking_delta`), `StreamDiagnostics.telemetry` (Codex `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`, terminal status) and `MiniMaxStreamHandler`. The Analytics tab's Usage insights section reads `GET /analytics/insights`. It is analysis-only and never influences routing or account selection.

**Multi-window:** multiple Cursor windows sync via a file-based runtime state in `~/.ungate/`. One window is the leader (runs the API), others read state. Heartbeat-based liveness, command queue for coordinated actions (start/restart/stop tunnel, restart API). Tunnel owner window handles tunnel lifecycle.

**OpenAI Key Fix:** Cursor periodically resets the OpenAI API Key field in settings. Ungate automatically restores it via `aiSettings.usingOpenAIKey.toggle` command. Direct SQLite writes to `state.vscdb` do not work — Cursor never re-reads reactive storage. Only the leader window runs the fix loop, state is shared via runtime state file.

**Auto tunnel:** opt-in toggle (`autoTunnel` in the runtime state file, default off, next to the key auto-fix in the dashboard tunnel panel and status bar, command `ungate.toggleAutoTunnel`). `auto-tunnel.ts` starts the quick tunnel once per API process in the window that owns tunnel commands, as soon as the API is running; it never retries a failed start in a loop. Each time the tunnel URL changes (`autoTunnel.lastAppliedUrl`, shared so only one window announces), it copies `<url>/v1`, turns on Cursor's OpenAI API Key switch, and shows a notification that opens Cursor Settings → Models. Cursor exposes no command for extensions to write `openAIBaseUrl` (reactive storage) or the key (`secret://cursorAuth/openAIKey`), so pasting the URL stays a manual step.

**Codex streaming variants:** ChatGPT Codex `/responses` has two tool streaming formats — classic `function_call` + `response.function_call_arguments.*` and extended `custom_tool_call` + `response.custom_tool_call_input.*`. Both must be mapped to OpenAI `tool_calls`. Stream mapper processes both. OmniRoute only handles `function_call` — `custom_tool_call` is Ungate-specific.

**MiniMax reasoning:** MiniMax M2.7 streams `<think>`/`</think>` tags as reasoning content. Split tags across chunks are reassembled via `pendingTag` state in `minimax-stream-handler.ts`. Cursor renders this as collapsed "Planning next moves" (non-expandable). Non-streaming responses use `【 Reasoning: ... 】` / `<output>` format (separate parser, not yet implemented).

**Cursor architectural constraint:** Requests go through Cursor backend (`api2.cursor.sh`), not from the local machine. This means localhost never works as OpenAI Base URL — a public tunnel is always required. Cursor 3.0 regression: built-in model names can bypass the custom base URL entirely, requiring custom model IDs from Ungate's model registry.

**Reasoning budget tiers:** `null` (no extended thinking), `medium`, `high`. Default model IDs use the base name (e.g. `sonnet-4.6`); extended-reasoning variants use `-medium` and `-high` suffixes (e.g. `sonnet-4.6-medium`, `sonnet-4.6-high`). The tier is encoded in the model ID; Cursor strips the suffix when forwarding, so the tier must be recovered from the suffix before the request is sent upstream.
