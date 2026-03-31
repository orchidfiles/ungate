<p align="center">
  <img src="https://raw.githubusercontent.com/orchidfiles/ungate/main/apps/extension/resources/icon.png" alt="Ungate" width="80" />
</p>

<h3 align="center">Ungate</h3>

<p align="center">
  Use any Anthropic model in Cursor via a local proxy that translates OpenAI API calls into Anthropic API calls.
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/orchidfiles/ungate"><img src="https://img.shields.io/open-vsx/dt/orchidfiles/ungate" alt="Open VSX Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://github.com/orchidfiles/ungate"><img src="https://img.shields.io/github/last-commit/orchidfiles/ungate" alt="Last commit" /></a>
</p>

## Why

Cursor supports Claude via API key, but that means paying per token. If you have a Claude Pro or Max subscription, you already have access — Cursor just can't use it. Ungate authenticates with your Claude account via OAuth and exposes an OpenAI-compatible endpoint for Cursor.

## How it works

Cursor allows a custom OpenAI Base URL. Ungate listens on that URL and translates requests to the Anthropic API — streaming, tool calls, and vision.

The extension starts the proxy as a child process and displays the URL in a Webview panel. Copy it into Cursor Settings → Models → OpenAI Base URL.

## Features

- [x] OpenAI-to-Anthropic request translation
- [x] Streaming responses
- [x] Tool calls mapping
- [x] Image support
- [x] OAuth authentication via Claude account
- [x] Request analytics
- [x] Built-in web UI panel

## Installation

Install from the marketplace:

```sh
cursor --install-extension orchidfiles.ungate
```

Or search `@id:orchidfiles.ungate` in the Extensions panel.

[Open VSX](https://open-vsx.org/extension/orchidfiles/ungate)

## Setup

1. Open the Ungate panel from the Activity Bar.
2. Sign in with your Claude account.
3. Copy the proxy URL shown in the panel.
4. Paste it into Cursor Settings → Models → OpenAI Base URL.
5. Select a model in Cursor and start chatting.

## Development

```sh
git clone https://github.com/orchidfiles/ungate.git
cd ungate
pnpm install
```

Build dev-kit (needed once, before other builds):

```sh
pnpm --filter @ungate/dev-kit build
```

Build the API:

```sh
pnpm --filter @ungate/api build
```

Build the extension:

```sh
pnpm --filter ungate build
```

## License

MIT

## Support

Bug reports and feature requests: [GitHub issues](https://github.com/orchidfiles/ungate/issues)  
Everything else: [orchid@orchidfiles.com](mailto:orchid@orchidfiles.com)

---

Made by the author of [orchidfiles.com](https://orchidfiles.com) — essays from inside startups.  
If you found `ungate` useful, you'll probably enjoy the essays.
