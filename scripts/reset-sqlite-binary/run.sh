#!/bin/sh
# Removes the runtime-installed better-sqlite3 binary so the extension
# re-downloads it on the next API start (reproduces prebuild failures).

rm -f apps/api/node_modules/better-sqlite3/build/Release/better_sqlite3.installed.node
echo "removed better_sqlite3.installed.node"
