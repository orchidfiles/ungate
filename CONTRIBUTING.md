# Contributing to Ungate

## Quick start

```sh
git clone https://github.com/orchidfiles/ungate.git
cd ungate
pnpm install
```

### Run the dev loop

In Cursor/VS Code:

1. **Command Palette → Run Task → `build:watch all`** — starts the dev-kit, shared, web, and api watchers as background tasks.
2. Press **F5** to launch the extension in debug mode. The proxy (`apps/api`) is spawned by the extension as a child Node process; its port is detected from stdout.

Individual tasks (`dev-kit build`, `shared build-watch`, `api build-watch`, `web build-watch`) are available in the Run Task picker if you only need a subset. `@ungate/dev-kit` does not expose a watch task — it only ships the lint and vitest configs, so a single `build` after editing it (or after `pnpm install`) is enough.

If you prefer running watchers yourself (no Cursor UI), the underlying commands are:

```sh
pnpm --filter @ungate/dev-kit build
pnpm --filter @ungate/shared build:watch
pnpm --filter @ungate/api build:watch
pnpm --filter @ungate/web build:watch
```

If you only want to iterate on the proxy without the extension UI:

```sh
cd apps/api
DB_PATH=$HOME/.ungate/data-dev.db PORT=4784 node dist/main.js
```

## Prerequisites

- **Node.js 22, 24, or 26** — other versions fail on the `better-sqlite3` ABI. If the API child fails to start with `No prebuilt binary for ABI ...`, your Node version is the cause.
- **pnpm** — the repo is a pnpm workspace.
- **Cursor** with custom OpenAI provider support enabled.

`better-sqlite3`, `cloudflared`, and the `sqlite3` CLI are downloaded and verified automatically on first run through `utils/verified-artifact.ts` with SHA-256 allowlists per platform and Node ABI. You do not need to install them manually.

## Repo structure

```
ungate/
├── apps/
│   ├── api/          # Fastify proxy server
│   ├── extension/    # VS Code / Cursor extension
│   └── web/          # Svelte dashboard
├── packages/
│   ├── shared/       # Types, schemas, constants
│   └── dev-kit/      # ESLint and vitest configs
└── scripts/          # Build and tunnel utilities
```

Data flow: Cursor sends a request from its backend, the request is forwarded through a Cloudflare tunnel to the local proxy, and the proxy translates it to the target provider API.

## Debugging tips

- **API logs** live in two ring buffers of 500 entries each (API stdout/stderr and tunnel stderr), surfaced from the dashboard's Logs tab.
- **Databases**: `~/.ungate/data.db` is the production default; `~/.ungate/data-dev.db` is used when `DB_PATH` is set. Always check which one the running process is using before debugging analytics or auth issues.
- **Native binaries** (`better-sqlite3`, `cloudflared`, `sqlite3` CLI) are stored in `~/.ungate/bin/` with a `<binary>.sha256` stamp. A managed binary without a matching stamp is treated as unverified and re-downloaded.

## Things the linter can't catch

Linting is automatic via ESLint and Prettier configs in `packages/dev-kit`. Pre-commit runs `lint:fix`, so committed code is always formatted. A few things the linter will not catch that we care about:

- **Don't bypass `VerifiedArtifact`** when adding or updating a downloaded binary. Pin the URL and add the SHA-256 to the allowlist. Do not introduce fallbacks to `latest` releases.
- **Don't write to `state.vscdb` directly** for the OpenAI Key Fix. Cursor ignores reactive storage writes; use `aiSettings.usingOpenAIKey.toggle`.
- **Add bidirectional entries to `src/proxy/tool-mapper.ts`** for any tool you support. Claude OAuth rejects unknown tool names server-side.
- **Don't drop the model-routing branch order** in `src/routes/openai.ts`. MiniMax → mapped → Claude, in that order. Reordering routes MiniMax traffic to Claude and breaks OAuth.

## Testing

- Unit tests live co-located with the code you change, in the matching app's `src/`.
- Run them with `pnpm test`. The API server is testable in isolation via `apps/api/dist/main.js` on a custom `PORT` and `DB_PATH`.
- Changes in streaming code (`src/streaming/`, `src/proxy/responses-stream-mapper/`) should include tests for both `function_call` and `custom_tool_call` Codex variants.
- OAuth and tunnel code paths are exercised manually because they require real provider accounts and a public tunnel.

## Pull requests

1. Fork and create a branch off `main`: `git checkout -b feat/<short-name>` or `fix/<short-name>`.
2. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages. PRs are squash-merged.
3. Husky's pre-commit hook runs `pnpm lint:fix` and `pnpm test` automatically. CI is not configured yet, so a passing local commit is the only gate.
4. File an issue before opening a *feature* PR so we can agree on scope. Bugfixes and docs PRs can go straight to a PR. Ungate is small on purpose.
5. PR description should cover:
   - **What** changes.
   - **Why** — link the issue or describe the motivation.
   - **How to test** — manual steps or new test cases.
   - Any **breaking changes** to tunnel, OAuth, or streaming behavior. Flag these explicitly because they touch user-visible paths.
6. Keep PRs focused. Split unrelated cleanups into separate PRs.

## Community and license

- **Bugs and feature requests:** [GitHub Issues](https://github.com/orchidfiles/ungate/issues). Use the bug/feature templates.
- **Security issues:** see `SECURITY.md` for private vulnerability reporting.
- **Anything else:** `orchid@orchidfiles.com`. For other channels, see [orchidfiles.com](https://orchidfiles.com).

By contributing, you agree that your contributions are licensed under the MIT License (see `LICENSE`).
