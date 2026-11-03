#!/usr/bin/env bash
# Runs the pinright latency scripts in a scratch dir. Usage: run.sh <src dir> <work dir>
set -euo pipefail
SRC="$1"; WORK="$2"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -r "$SRC/scripts" "$SRC/package-lock.json" "$SRC/pinright-1.0.0.tgz" "$WORK/"
# Install into a subdir so npm does not overwrite the copied package-lock.json that check-manifest reads.
mkdir -p "$WORK/inst" && cd "$WORK/inst"
echo '{"name":"bench","version":"0.0.0","private":true}' > package.json
npm install --ignore-scripts --no-audit --no-fund ../pinright-1.0.0.tgz >/dev/null 2>&1
cd "$WORK"
CLI="$WORK/inst/node_modules/pinright/dist/cli.js"
echo "== env"
echo "node $(node --version), npm $(npm --version), $(uname -srm)"
[ -r /etc/os-release ] && . /etc/os-release && echo "os: ${PRETTY_NAME:-unknown}"
command -v sw_vers >/dev/null && sw_vers
echo "cpus: $(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
echo "pinright $(node "$CLI" --version)"
echo "== node -e 0 (7 runs, ms)"
for i in 1 2 3 4 5 6 7; do
  node -e 'const t=process.hrtime.bigint();require("child_process").spawnSync(process.execPath,["-e","0"]);console.log(Number(process.hrtime.bigint()-t)/1e6|0)'
done | tr '\n' ' '; echo
if [ "${ONLY:-}" != "mcp" ]; then
echo "== latency.ts"
node scripts/latency.mjs --runs=5 --cli="$CLI" 2>/dev/null
fi
for k in 1 2 3; do
  echo "== mcp-latency.ts run $k"
  node scripts/mcp-latency.mjs --cli="$CLI"
done
