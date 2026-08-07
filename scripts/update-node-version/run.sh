#!/bin/sh
# Bumps the Node version used by non-interactive shells (VS Code tasks, GUI apps).
# - resolves the target version (arg, "NN", or newest installed in nvm)
# - installs it via nvm if missing
# - ensures pnpm is installed in that version
# - updates ~/.zshenv PATH and the nvm default alias

set -e

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ ! -d "$NVM_DIR/versions/node" ]; then
	echo "nvm versions dir not found: $NVM_DIR/versions/node" >&2
	exit 1
fi

. "$NVM_DIR/nvm.sh"

resolve_version() {
	target="$1"

	if [ -z "$target" ]; then
		ls -1 "$NVM_DIR/versions/node" | sed 's/^v//' | sort -V | tail -1
		return
	fi

	case "$target" in
	*.*)
		echo "$target"
		;;
	*)
		ls -1 "$NVM_DIR/versions/node" | sed 's/^v//' | sort -V | grep "^$target\." | tail -1 || true
		;;
	esac
}

target="${1:-}"
if [ -z "$target" ]; then
	printf 'Node version (e.g. 26, 24.15.0): '
	read -r target
fi

if [ -z "$target" ]; then
	echo "no version given" >&2
	exit 1
fi

version="$(resolve_version "$target")"

if [ -z "$version" ]; then
	echo "no installed Node version matches: $1" >&2
	exit 1
fi

if [ ! -d "$NVM_DIR/versions/node/v$version" ]; then
	echo "installing node v$version via nvm..."
	nvm install "$version"
fi

bin_dir="$NVM_DIR/versions/node/v$version/bin"

if [ ! -x "$bin_dir/pnpm" ]; then
	echo "installing pnpm into node v$version..."
	"$bin_dir/node" "$bin_dir/npm" install -g pnpm
fi

nvm alias default "$version" >/dev/null

zshenv="$HOME/.zshenv"
managed='^export PATH="[^"]*versions/node/v[0-9.][0-9.]*/bin:\$PATH"$'
tmp="$(mktemp)"

if [ -f "$zshenv" ]; then
	sed -e "\|$managed|d" -e "/^# node for non-interactive shells/d" "$zshenv" >"$tmp"
else
	: >"$tmp"
fi

if [ -s "$tmp" ] && [ "$(tail -c 1 "$tmp" | wc -l | tr -d ' ')" -eq 0 ]; then
	printf '\n' >>"$tmp"
fi

if ! grep -q '^export NVM_DIR=' "$tmp"; then
	printf 'export NVM_DIR="%s"\n' "$HOME/.nvm" >>"$tmp"
fi

printf '\n# node for non-interactive shells (VS Code tasks, GUI apps)\n' >>"$tmp"
printf 'export PATH="%s:$PATH"\n' "$bin_dir" >>"$tmp"

mv "$tmp" "$zshenv"

echo "node v$version is now the runtime:"
echo "  \$HOME/.zshenv -> v$version/bin"
echo "  nvm default   -> v$version"
echo "  node: $("$bin_dir/node" -v)  pnpm: $("$bin_dir/pnpm" -v)"
