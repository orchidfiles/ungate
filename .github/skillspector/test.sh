#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$here/skillscan.sh" --build
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 128 --memory 2g --cpus 2 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m --tmpfs /scan --tmpfs /reports \
  --tmpfs /fixture --env HOME=/tmp --workdir /tmp \
  --mount "type=bind,source=$here,target=/runner,readonly" \
  --entrypoint python skillspector-local:f08a32bfdb2ef232e6b0157ec3bce78ec7a610d6 \
  /runner/test.py
