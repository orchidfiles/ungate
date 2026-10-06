# Security policy

Ungate runs a local proxy in front of your Claude, ChatGPT, and MiniMax subscriptions. It also runs a public tunnel that exposes that proxy to Cursor's backend. This document describes what is in scope, how to report a vulnerability, and the threat model you should keep in mind when reviewing or extending the code.

## Supported versions

Only the latest release on [Open VSX](https://open-vsx.org/extension/orchidfiles/ungate) and the matching `main` branch on GitHub receive security fixes. Older releases are not patched.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| `main` branch | Yes |
| Older releases | No |

## Reporting a vulnerability

Report through either channel:

- **GitHub Private vulnerability reporting** — [report here](https://github.com/orchidfiles/ungate/security/advisories/new). Encrypted end to end and kept out of public issue trackers.
- **Email:** `orchid@orchidfiles.com`. For other channels, see [orchidfiles.com](https://orchidfiles.com).

Please **do not** file public issues for suspected vulnerabilities.

### What to include

A useful report covers:

- **What** — short description of the issue.
- **Reproduction** — minimal steps. For tunnel- or OAuth-related reports, say whether `DB_PATH` was set (so we know whether the dev database is involved).
- **Expected vs actual** — what you expected to happen and what happened instead.
- **Environment** — Ungate version, Cursor version, OS, Node.js version.
- **Logs** — excerpt from the API or tunnel ring buffer (Logs tab in the dashboard), not the full file.
- **Subscription type** — Claude / ChatGPT / MiniMax / multiple. Tells us which provider handlers to read first.

Do not include OAuth tokens, refresh tokens, the proxy API key, or the tunnel URL in the report. Rotate them from the dashboard after the report is sent if they were exposed.

### Response

Response and remediation are **best effort**. Ungate is a small project maintained in personal time. There is no fixed acknowledgement or fix window. We will reply when we have something concrete to say and publish a GitHub Security Advisory once a fix ships.

You are not required to wait for a fix before disclosing publicly. If you choose to disclose, please mention the report so we can cross-link.

## Threat model

The proxy sits between Cursor (which calls from `api2.cursor.sh`) and three upstream providers. The relevant surfaces are:

### Credentials stored locally

| Asset | Where | Notes |
|---|---|---|
| OAuth access and refresh tokens | `~/.ungate/data.db`, table `provider_settings` | Refresh tokens are long-lived. Compromising the SQLite file is equivalent to owning the subscription. |
| Proxy API key | `~/.ungate/data.db`, table `app_settings.apiKey` | Anyone with the tunnel URL **and** this key can send requests through your proxy and incur provider usage. |
| Tunnel URL | `~/.ungate/data.db` and Cloudflare's quick-tunnel subdomain | Treat as a secret. Rotating the tunnel from the dashboard invalidates the old URL. |
| User OAuth flow secrets | `apps/api/src/auth/` | PKCE verifier/challenge during login; never written to disk. |

### Cursor's OpenAI API Key

Cursor periodically turns off its `OpenAI API Key` setting. Ungate restores it via the `aiSettings.usingOpenAIKey.toggle` command. Direct SQLite writes to Cursor's `state.vscdb` do not work — Cursor ignores reactive storage writes — so Ungate only uses the command path. This is a Cursor behavior Ungate works around, not a Ungate credential.

### Tunnel and proxy

- **Cloudflare quick tunnel** is used by default. The tunnel URL is publicly reachable. The proxy API key is the only authentication on the public endpoint — there is no IP allowlist, no rate limit on the extension side, and no per-request attribution.
- Anyone holding both the tunnel URL and the proxy API key can issue arbitrary completions and stream tool calls through your subscription. Rotate the proxy key from the dashboard whenever you suspect leakage.
- The tunnel is **not** auto-started. It only comes up after explicit user action.

### Native binaries

Three binaries are downloaded on first run: `better-sqlite3`, `cloudflared`, and the `sqlite3` CLI. All three go through `utils/verified-artifact.ts`:

- Pinned upstream URL per platform and (for `better-sqlite3`) Node ABI.
- SHA-256 allowlist per platform/arch/ABI.
- Bytes are hashed while streaming into a staging directory and compared with `timingSafeEqual` before anything is extracted, copied, chmod-ed, or executed.
- Staging is deleted on failure. Unknown platform/ABI tuples fail closed — there is no fallback to `latest`.
- Each managed binary carries a `<binary>.sha256` stamp. A managed binary without a matching stamp is treated as unverified and replaced.
- There is no manual drop-in override — a directory whose contents are not stamped would be rejected anyway.

This is the only attack surface where Ungate pulls code from the internet. Adding a new binary, a new platform, or a new Node ABI requires both a pinned URL and a SHA-256 entry in the allowlist. The verified-artifact code path is covered by unit tests; a PR that adds a new binary or platform without a corresponding vitest case will be asked to add one.

### Multi-window coordination

The extension uses a file-based runtime state in `~/.ungate/` to coordinate multiple Cursor windows: leader election, heartbeats, command queue for tunnel/API lifecycle, and ownership of the OpenAI Key Fix loop. The state file is on the local filesystem and trusts the local user account. Tampering with it from another local process can cause restart loops or duplicate tunnel owners; it cannot exfiltrate credentials on its own.

### External constraints

A few things look like bugs but are requirements of the providers we integrate with. Do not report them as vulnerabilities.

- **Anthropic OAuth fingerprint.** The Anthropic OAuth client sends a fixed request fingerprint: `?beta=true` URL suffix, `User-Agent: claude-cli/2.1.9`, the full `x-stainless-*` header set, `anthropic-dangerous-direct-browser-access: true`, and three `anthropic-beta` feature flags. Changing any of these makes Anthropic reject the request. See `apps/api/src/config.ts` and the request builder.
- **Cursor backend cannot reach `localhost`.** All requests must go through the tunnel. This is why Ungate ships one.
- **`better-sqlite3` is matched against the host Node ABI**, not against Electron's. Supported Node versions are 22, 24, and 26.

## Severity classification

We use a simple scale when triaging reports:

- **Critical** — remote unauthenticated access to credentials, remote code execution through the proxy or tunnel, or exfiltration of OAuth tokens from `data.db`.
- **High** — credential theft through XSS, SSRF, or arbitrary code paths in the dashboard or proxy; tunnel-URL/key exposure via logs or error responses; bypass of the `VerifiedArtifact` SHA-256 check.
- **Medium** — information disclosure that helps an attacker (provider name leaks, token-format leaks in error paths); denial of service in the proxy or extension that requires a restart loop.
- **Low** — anything else: cosmetic log leaks, non-sensitive stack traces, UI bugs with security flavor.

Reports we cannot classify land in **Low** and may not receive a fix if there is no realistic impact.

## Known limitations (non-vulnerabilities)

These are documented in [README.md](README.md) and listed here so they are not reported as bugs:

- **Built-in Cursor model IDs bypass the custom base URL.** Ungate can only route model IDs that the user has added as custom models in Cursor.
- **`localhost` does not work as `OpenAI Base URL`.** Cursor's backend cannot reach it. A public tunnel is required.
- **`better-sqlite3` binary is matched against the host Node ABI**, not against Electron's. Mismatched Node versions cause `No prebuilt binary for ABI ...`.
- **Quick tunnels** use random Cloudflare subdomains. They are reachable to anyone who learns the URL.
- The proxy has **no per-request rate limit** on the extension side. Providers still enforce their own limits, but a leaked key can drive sustained usage.

## Published advisories

Past advisories are listed on the [GitHub Security Advisories tab](https://github.com/orchidfiles/ungate/security/advisories). When a fix ships, the advisory credits the reporter with their permission. If you reported something that was fixed and want your handle included, mention it in the original report or reply to the advisory draft.

## What we will and will not do

We will:

- Acknowledge your report and tell you which severity tier we placed it in.
- Publish a GitHub Security Advisory once a fix is shipped, crediting you (with your permission).
- Rotate any tokens or keys you believe were exposed, on request.

We will not:

- Pursue legal action against researchers who report in good faith.
- Demand a coordinated disclosure window. You may disclose on your own schedule.
- Pay bug bounties. There is no bounty program.