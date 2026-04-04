<p align="center">
  <img src="https://raw.githubusercontent.com/orchidfiles/ungate/main/apps/extension/resources/icon.png" alt="Ungate" width="80" />
</p>

<h3 align="center">Ungate</h3>

<p align="center">
  Use Claude subscription and MiniMax in Cursor through a local proxy that translates OpenAI-style requests into provider-native APIs.
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/orchidfiles/ungate"><img src="https://img.shields.io/open-vsx/dt/orchidfiles/ungate" alt="Open VSX Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://github.com/orchidfiles/ungate"><img src="https://img.shields.io/github/last-commit/orchidfiles/ungate" alt="Last commit" /></a>
</p>

## Why

Cursor can connect to OpenAI-compatible APIs, but provider-specific flows still get in the way. Claude subscriptions work through OAuth, not Anthropic API keys. MiniMax works through its own API and has provider-specific streaming behavior. Ungate hides those differences behind one local proxy and one Cursor-compatible endpoint.

## How it works

Cursor allows a custom OpenAI Base URL. Ungate listens on that URL and translates requests to the target provider API, including streaming, tool calls, and vision where supported.

Cursor 3.0 introduced a bug: built-in model names can bypass `OpenAI Base URL` and go straight to the real provider API. In practice this means requests for standard Claude model names may skip Ungate entirely even when a proxy URL is configured. Ungate treats this as a bug because Cursor ignores the user's proxy setting for those models.

Workaround: use custom model IDs from the Ungate `Models` section instead of Cursor's built-in Claude model names.

The extension starts the proxy as a child process and shows its settings in a Webview panel. From there you configure the provider, copy the public proxy URL, and copy the proxy API key that Cursor uses to authenticate to your local proxy.

## Features

- [x] OpenAI-to-provider request translation
- [x] Streaming responses
- [x] Tool calls mapping
- [x] Image support
- [x] OAuth authentication via Claude account
- [x] MiniMax API key authentication
- [x] MiniMax `<think>...</think>` reasoning separation
- [x] Request analytics
- [x] Analytics split by provider: Claude and MiniMax
- [x] Built-in web UI panel

## Installation

Install from the marketplace:

```sh
cursor --install-extension orchidfiles.ungate
```

Or search `@id:orchidfiles.ungate` in the Extensions panel.

[Open VSX](https://open-vsx.org/extension/orchidfiles/ungate)

## Setup

1. Install the extension. Ungate starts the local API automatically.
2. Click the `Ungate :<port>` item in the status bar to open the Ungate panel.
3. Choose the provider you want to use.
4. For Claude, sign in with your Claude account through OAuth.
5. For MiniMax, enter your MiniMax API key and choose a Base URL: `Global`, `China`, or `Custom`.
6. In the Tunnel section, click `Start tunnel`, then copy the public URL shown in the panel.
7. Paste it into Cursor Settings → Models → OpenAI Base URL.
8. Copy the proxy API key from the same panel and paste it into Cursor Settings → Models → OpenAI API Key.
9. In the Ungate `Models` section, copy the model IDs you want and add them as custom models in Cursor.
10. If you use MiniMax, add `MiniMax-M2.7` as a custom model in Cursor.
11. Select one of your custom models in Cursor and start chatting.

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
