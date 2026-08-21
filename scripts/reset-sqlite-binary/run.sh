#!/bin/sh
# Removes the runtime-installed better-sqlite3 binary and its pinned-checksum
# stamp so the extension re-downloads and re-verifies it on the next API start
# (reproduces prebuild failures).

rm -f apps/api/node_modules/better-sqlite3/build/Release/better_sqlite3.installed.node
rm -f apps/api/node_modules/better-sqlite3/build/Release/better_sqlite3.installed.node.sha256
echo "removed better_sqlite3.installed.node and its checksum stamp"
