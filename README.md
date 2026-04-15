<p align="center">
  <img src="https://raw.githubusercontent.com/orchidfiles/ungate/main/apps/extension/resources/icon.png" alt="Ungate" width="80" />
</p>

<h3 align="center">Ungate</h3>

<p align="center">
  A Cursor-first extension for using Claude, ChatGPT, and MiniMax subscriptions in Cursor<br/> instead of paying for API tokens.
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/orchidfiles/ungate"><img src="https://img.shields.io/open-vsx/dt/orchidfiles/ungate" alt="Open VSX Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://github.com/orchidfiles/ungate"><img src="https://img.shields.io/github/last-commit/orchidfiles/ungate" alt="Last commit" /></a>
</p>

## How it works

Ungate lets you use Claude, ChatGPT, and MiniMax in Cursor through account subscriptions instead of direct API token billing. Claude and ChatGPT authenticate via OAuth; MiniMax uses provider API credentials.

Cursor allows a custom OpenAI Base URL. Ungate listens on that URL and translates requests to the target provider API, including streaming, tool calls, and vision where supported.

The extension manages the tunnel that makes the proxy reachable to Cursor's backend and shows its settings in a Webview panel. From there you configure providers, copy the public proxy URL, and copy the proxy API key that Cursor uses to authenticate to your local proxy.

Note: Cursor has a known issue where built-in model names bypass `OpenAI Base URL` and go straight to the real provider API, ignoring your proxy setting. Use custom model IDs from the Ungate `Models` section instead of Cursor's built-in Claude model names.

## Features

- [x] OpenAI-to-provider request translation
- [x] Streaming responses
- [x] Tool calls mapping
- [x] Image support
- [x] OAuth authentication via Claude or ChatGPT account
- [x] MiniMax API key authentication
- [x] MiniMax `<think>...</think>` reasoning separation
- [x] Request analytics
- [x] Analytics split by provider: Claude, OpenAI, and MiniMax
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
5. For ChatGPT, sign in with your ChatGPT account through OAuth.
6. For MiniMax, enter your MiniMax API key and choose a Base URL: `Global`, `China`, or `Custom`.
7. In the Tunnel section, click `Start tunnel`, then copy the public URL shown in the panel.
8. Paste it into Cursor Settings → Models → OpenAI Base URL.
9. Copy the proxy API key from the same panel and paste it into Cursor Settings → Models → OpenAI API Key.
10. In the Ungate `Models` section, copy the model IDs you want and add them as custom models in Cursor.
11. If you use MiniMax, add `MiniMax-M2.7` as a custom model in Cursor.
12. Select one of your custom models in Cursor and start chatting.

## Local build and install in Cursor

```sh
git clone https://github.com/orchidfiles/ungate.git
cd ungate
pnpm install
pnpm run package:build
cursor --install-extension "apps/extension/out/ungate.vsix"
```

## Development

Run the build in watch mode in one step with `Command Palette -> Run Task -> build:watch all`.

Or run it manually in the terminal:

```sh
pnpm --filter @ungate/dev-kit build
pnpm --filter @ungate/shared build:watch
pnpm --filter @ungate/api build:watch
pnpm --filter @ungate/web build:watch
```

After the build, press `F5` to test the extension in Cursor debug mode.

You can also run the API separately from the extension on another port:

```sh
cd apps/api

# use the default database:
PORT=4784 node dist/main.js

# use a separate dev database:
DB_PATH=$HOME/.ungate/data-dev.db PORT=4784 node dist/main.js
```

## License

MIT

## Support

Bug reports and feature requests: [GitHub issues](https://github.com/orchidfiles/ungate/issues)  
Everything else: [orchid@orchidfiles.com](mailto:orchid@orchidfiles.com)

---

Made by the author of [orchidfiles.com](https://orchidfiles.com) — essays from inside startups.  
If you found `ungate` useful, you'll probably enjoy the essays.
