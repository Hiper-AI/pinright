#!/bin/sh
# Entry point of one sandboxed benchmark job. The harness mounts the job directory at /job
# (mcp.json, settings.json, and where work/ and hook-events.jsonl land) and the host's Claude
# credentials read-only at /creds/.credentials.json. Arguments are passed to `claude` as is.
# The project is written in /work, inside the container; when the agent ends, its files are
# copied to /job/work without installed dependencies, so scoring sees manifests and lockfiles.
set -u
mkdir -p "$HOME/.claude" /job/work
if [ -f /creds/.credentials.json ]; then
  cp /creds/.credentials.json "$HOME/.claude/.credentials.json"
  chmod 600 "$HOME/.claude/.credentials.json"
fi
cd /work
claude "$@"
code=$?
tar -C /work \
  --exclude='node_modules' --exclude='.venv' --exclude='venv' --exclude='env' --exclude='__pycache__' \
  --exclude='site-packages' --exclude='.next' --exclude='.nuxt' --exclude='.output' --exclude='.cache' \
  --exclude='dist' --exclude='build' \
  -cf - . | tar -C /job/work -xmf - --no-same-owner --no-same-permissions --no-overwrite-dir
exit $code
