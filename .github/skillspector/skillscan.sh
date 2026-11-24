#!/usr/bin/env bash
# Requires Bash, Git, Docker and GNU timeout. Run from any repository directory.
set -euo pipefail
umask 077
revision=f08a32bfdb2ef232e6b0157ec3bce78ec7a610d6
image="skillspector-local:$revision"
root=$(git rev-parse --show-toplevel)
runner=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/skillscan.py
work=$(mktemp -d)
container="skillscan-$(id -u)-$$-$RANDOM"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! docker image inspect "$image" >/dev/null 2>&1; then
  git init -q "$work/source"
  git -C "$work/source" fetch --depth 1 https://github.com/NVIDIA/SkillSpector.git "$revision"
  git -C "$work/source" checkout -q --detach FETCH_HEAD
  test "$(git -C "$work/source" rev-parse HEAD)" = "$revision"
  docker build --tag "$image" "$work/source"
fi
if [[ ${1:-} == --build ]]; then exit 0; fi
git -C "$root" ls-files -z --cached --others --exclude-standard > "$work/files"
# Reports contain source excerpts. Keep them outside the checkout, private by default.
reports=$(mktemp -d "${TMPDIR:-/tmp}/skillspector-report.XXXXXXXX")
printf 'SkillSpector reports: %s\n' "$reports"
code=0
timeout --signal=TERM --kill-after=15s 20m docker run --rm --name "$container" \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 128 --memory 2g --cpus 2 --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m --workdir /tmp \
  --env HOME=/tmp --env LANGCHAIN_TRACING_V2=false --env LANGSMITH_TRACING=false \
  --mount "type=bind,source=$root,target=/scan,readonly" \
  --mount "type=bind,source=$runner,target=/runner.py,readonly" \
  --mount "type=bind,source=$work/files,target=/files,readonly" \
  --mount "type=bind,source=$reports,target=/reports" \
  --entrypoint python "$image" /runner.py || code=$?
case "$code" in
  0) printf 'PASS_STATIC: all selected targets completed without findings (not an LLM audit).\n';;
  1) printf 'FAIL: findings or incomplete analysis; review private reports.\n' >&2;;
  3) printf 'NO_TARGETS: not applicable, not a security pass.\n';;
  *) printf 'SCAN_ERROR: scanner did not complete (exit %s).\n' "$code" >&2; exit 2;;
esac
exit "$code"
