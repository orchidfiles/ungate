# Changelog

## 1.7.10 - 2026-08-14

- Fix interrupted Claude tool streams being truncated or partially executed; raise thinking default to 32k tokens

## 1.7.9 - 2026-08-13

- Fix 400 on accepting a Cursor plan with Claude models by sanitizing tool ids from plan history (`functions.X:1` → `functions_X_1`)

## 1.7.8 - 2026-08-10

- Fix 413 on multi-image Cursor requests by raising the request body limit to 256 MiB
- Check the API key before the body is parsed so unauthorized requests are not buffered

## 1.7.7 - 2026-08-07

- Fix API server failing to start on Node 26 by bumping better-sqlite3 to 12.11.1
- Drop Node 20 and 23 support; supported runtimes: Node 22, 24, 26

## 1.7.6 - 2026-08-06

- Fix GPT-5.6 priority-tier models failing when Cursor strips the reasoning tier from the model id

## 1.7.5 - 2026-07-29

- Add GPT-5.6 Sol, Terra, and Luna support with configurable reasoning and OpenAI service tiers
- Seed six focused medium-effort defaults covering normal and priority service
- Preserve the selected dashboard page, settings provider/model, and per-page scroll position across webview reloads

## 1.7.4 - 2026-07-27

- Fix adding custom models from dashboard returning 400
- Fix native binding loading failure on first run after upgrade
- Show API error details in dashboard when saving settings fails

## 1.7.3 - 2026-06-25

- Fix Anthropic provider errors with non-JSON bodies so upstream failures return a normal error response instead of crashing the API

## 1.7.2 - 2026-06-25

- Add Opus-4.8 model support
- Map reasoning tiers to adaptive thinking + effort for Opus 4.7/4.8 (previously dropped)
- Fix Codex (GPT-5.5) tool calls failing with "Missing required parameter: 'tools[0].name'" by flattening tools to Responses API format

## 1.7.1 - 2026-05-25

- Update changelog

## 1.7.0 - 2026-05-25

- Add Windows support

## 1.6.0 - 2026-05-19

- Sync API, tunnel, and OpenAI key-fix settings across all open Cursor windows
- Show the same API and tunnel logs in every dashboard window, with live updates and shared clear actions
- OpenAI key-fix is off by default; enable it from the dashboard or status bar if you want Ungate to keep `OpenAI API Key` enabled in Cursor
- Fix OpenAI key-fix so it turns the key back on after Cursor disables it, including when the extension starts with key-fix already enabled

## 1.5.2 - 2026-04-27

- Add GPT-5.5 and Opus-4.7 model support
- Preserve user-defined model mappings when adding new default models
- Support `xhigh` reasoning tier in model settings

## 1.5.1 - 2026-04-25

- Start quick tunnel with `--config /dev/null` to avoid Cloudflare 404 from local `~/.cloudflared/config.yml` ingress rules

## 1.5.0 - 2026-04-25

- Keep OpenAI API Key enabled when Cursor turns it off on its own
- Add on/off controls for this behavior in the status bar tooltip and dashboard

## 1.4.1 - 2026-04-22

- Fix Node 24 startup by updating bundled `better-sqlite3` and packaged API dependencies

## 1.4.0 - 2026-04-20

- Redesign provider settings and model management flow
- Add status bar hover tooltip with API state, tunnel URL, and quick actions
- Refactor extension module layout to simplify controller and lifecycle handling
- Upgrade analytics with provider and model filters, improved OpenAI stream accounting, and aggregated token timelines

## 1.3.2 - 2026-04-15

- Refactor API internals for auth, proxy helpers, stream mapping, and OpenAI chat orchestration
- Add local build, install, and debug instructions to README

## 1.3.0 - 2026-04-04

- Add ChatGPT OAuth authentication
- Add GPT and Codex model support through the model registry
- Track OpenAI usage in analytics and provider settings alongside Claude and MiniMax

## 1.2.0 - 2026-04-04

- Add custom model registry with editable model IDs
- Add dedicated `model_mappings` storage and settings UI CRUD for model mappings
- Document Cursor 3.0 bug where built-in model names can bypass `OpenAI Base URL` and hit the real provider API directly
- Fix MiniMax streaming tool call argument assembly so tools and planning mode work correctly

## 1.1.0 — 2026-04-03

- `MiniMax-M2.7` model support
- MiniMax Base URL selector: `Global`, `China`, `Custom`
- MiniMax streaming separates `<think>...</think>` reasoning from the final response
- Provider-aware analytics for Claude and MiniMax

## 1.0.1 — 2026-04-02

- Fix tunnel restart loop
- Add Stop button while tunnel is starting

## 1.0.0 — 2026-03-31

- OAuth login via Claude account
- Cloudflare quick tunnel for public URL
- OpenAI-compatible proxy
- Request log with token/cost tracking
- Web dashboard: analytics, logs, settings, tunnel control
- Models: Claude Sonnet 4.6, Opus 4.6, Haiku 4.5
