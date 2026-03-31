#!/bin/sh
# Shows active cloudflared tunnel processes

pids=$(pgrep -x cloudflared 2>/dev/null)

if [ -z "$pids" ]; then
	echo "No active tunnels"
	exit 0
fi

count=$(echo "$pids" | wc -l | tr -d ' ')
echo "Active tunnels: $count"
echo

for pid in $pids; do
	url=$(lsof -p "$pid" -a -i TCP 2>/dev/null | awk 'NR>1 {print $9}' | head -1)
	echo "  PID $pid  ${url:-<no tcp info>}"
done
