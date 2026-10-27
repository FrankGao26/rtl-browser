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

# Build the C++ index worker, TypeScript server and static WebUI.
# Can run directly or through tools/sandbox/rtl-bwrap with the build profile.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
NODE_VER="$(sed -n 's/.*"nodeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/tools/deps/versions.json" | head -1)"
NODE_DIR="$ROOT/.sandbox/deps/node-v${NODE_VER}-linux-x64"
if [[ -x "$NODE_DIR/bin/node" ]]; then
  export PATH="$NODE_DIR/bin:$PATH"
fi
DEPS="${RTL_DEPS_DIR:-$ROOT/.sandbox/deps}"
JOBS="${RTL_BUILD_JOBS:-4}"
SLANG_DIR="$DEPS/slang/lib64/cmake/slang"
if [[ ! -d "$SLANG_DIR" ]]; then
  SLANG_DIR="$DEPS/slang/lib/cmake/slang"
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need cmake
need node
need npm
need sha256sum

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 24 )); then
  echo "Node.js >= 24 is required (found $(node --version)); use the project sandbox launcher" >&2
  exit 1
fi
if [[ ! -d "$DEPS/slang" || ! -f "$DEPS/sqlite/sqlite3.c" ]]; then
  echo "dependencies are missing; run tools/deps/bootstrap.sh through the bootstrap profile" >&2
  exit 1
fi
if [[ ! -d "$SLANG_DIR" ]]; then
  echo "slang CMake package not found under $DEPS/slang" >&2
  exit 1
fi
SLANG_COMMIT="$(node -p "require('$DEPS/deps.lock.json').slang.commit" 2>/dev/null || echo unknown)"

echo "== configure native worker =="
cmake --fresh -S native/index-worker -B build/index-worker -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER_LAUNCHER= \
  -DCMAKE_CXX_COMPILER_LAUNCHER= \
  -DRTL_DEPS_DIR="$DEPS" \
  -DRTL_SLANG_COMMIT="$SLANG_COMMIT" \
  -Dslang_DIR="$SLANG_DIR"

echo "== build native worker =="
cmake --build build/index-worker --parallel "$JOBS"

echo "== typecheck =="
npm run typecheck

echo "== build TypeScript server and WebUI =="
npm run build

echo "build: PASS"
