#!/bin/sh
# Copies the project the agent wrote in /work to /job/work, without installed dependencies,
# virtualenvs or build output. Run by run-job.sh when the agent ends, and by the harness
# (docker exec) when the agent CLI stays up after its final result.
tar -C /work \
  --exclude='node_modules' --exclude='.venv' --exclude='venv' --exclude='env' --exclude='__pycache__' \
  --exclude='site-packages' --exclude='.next' --exclude='.nuxt' --exclude='.output' --exclude='.cache' \
  --exclude='dist' --exclude='build' \
  -cf - . | tar -C /job/work -xmf - --no-same-owner --no-same-permissions --no-overwrite-dir 2>/dev/null
touch /job/.copied
