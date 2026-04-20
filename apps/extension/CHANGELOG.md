# Changelog

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
