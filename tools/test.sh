#!/usr/bin/env bash
# Copyright 2026 Frank Gao
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Run typecheck, HTTP/semantic integration, security negative tests and the
# Playwright core UI flow. Can run directly or through the optional bwrap
# sandbox (offline once dependencies are installed).
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
NODE_VER="$(sed -n 's/.*"nodeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/tools/deps/versions.json" | head -1)"
NODE_DIR="$ROOT/.sandbox/deps/node-v${NODE_VER}-linux-x64"
if [[ -x "$NODE_DIR/bin/node" ]]; then
  export PATH="$NODE_DIR/bin:$PATH"
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need node
need npm

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 24 )); then
  echo "Node.js >= 24 is required (found $(node --version)); use the project sandbox launcher" >&2
  exit 1
fi
for f in dist/server/apps/server/src/main.js dist/web/index.html build/index-worker/index-worker; do
  if [[ ! -e "$f" ]]; then
    echo "missing build artifact: $f; run tools/build.sh first" >&2
    exit 1
  fi
done

echo "== typecheck =="
npm run typecheck

echo "== contracts =="
node tests/contracts.mjs

echo "== integration =="
node tests/integration.mjs

echo "== security =="
node tests/security.mjs

if [[ "${RTL_TEST_SKIP_UI:-0}" == "1" ]]; then
  echo "== UI: skipped (RTL_TEST_SKIP_UI=1) =="
else
  echo "== UI core flow =="
  node tests/e2e/ui-core.mjs
fi

if [[ -f tests/public-smoke.mjs ]]; then
  echo "== public medium design smoke =="
  node tests/public-smoke.mjs
fi

if [[ -f tests/advanced-smoke.mjs ]]; then
  echo "== advanced SystemVerilog smoke =="
  node tests/advanced-smoke.mjs
fi

if [[ -f tests/pulp-axi-smoke.mjs ]]; then
  echo "== pulp-platform AXI example smoke =="
  node tests/pulp-axi-smoke.mjs
fi

echo "test: PASS"
