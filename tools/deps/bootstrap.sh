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

# Project-private dependency bootstrap. Can run directly or through the
# optional tools/sandbox/rtl-bwrap bootstrap profile. No system package or host
# cache is modified; all downloads go to .sandbox/deps.
set -euo pipefail

ROOT="${RTL_PROJECT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd -P)}"
DEPS="$ROOT/.sandbox/deps"
EVID="$ROOT/.sandbox/evidence"
VERSIONS="$ROOT/tools/deps/versions.json"
mkdir -p "$DEPS" "$EVID" "$ROOT/build"

json_value() {
  local key="$1" value
  value="$(sed -n "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$VERSIONS" | head -1)"
  if [[ -z "$value" ]]; then
    echo "missing $key in $VERSIONS" >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

NODE_VER="$(json_value nodeVersion)"
NODE_URL="$(json_value nodeLinuxX64Url)"
NODE_SHA="$(json_value nodeLinuxX64Sha256)"
NODE_ARCHIVE="$DEPS/$(basename "$NODE_URL")"
NODE_DIR="$DEPS/node-v${NODE_VER}-linux-x64"
SQLITE_VER="$(json_value sqliteVersion)"
SQLITE_URL="$(json_value sqliteUrl)"
SQLITE_SHA="$(json_value sqliteSha256)"
SQLITE_ZIP="$DEPS/$(basename "$SQLITE_URL")"
SQLITE_SRC_NAME="$(basename "$SQLITE_URL" .zip)"
NLOHMANN_VER="$(json_value nlohmannJsonVersion)"
NLOHMANN_URL="$(json_value nlohmannJsonUrl)"
NLOHMANN_SHA="$(json_value nlohmannJsonSha256)"
SLANG_COMMIT="$(json_value slangCommit)"
SLANG_REPO="$(json_value slangRepository)"
JOBS="${RTL_BUILD_JOBS:-4}"

verify_sha() {
  local file="$1" expected="$2" label="$3" actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 mismatch for $label: $actual" >&2
    exit 1
  fi
}

download() {
  local url="$1" out="$2" expected="$3" label="$4"
  if [[ -f "$out" ]]; then
    verify_sha "$out" "$expected" "$label"
    return
  fi
  echo "download $label"
  curl -fsSL --retry 3 --retry-all-errors --connect-timeout 30 --max-time 300 \
    -o "$out.part" "$url"
  mv "$out.part" "$out"
  verify_sha "$out" "$expected" "$label"
}

download "$NODE_URL" "$NODE_ARCHIVE" "$NODE_SHA" "Node ${NODE_VER}"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  tar -xJf "$NODE_ARCHIVE" -C "$DEPS"
fi
export PATH="$NODE_DIR/bin:$PATH"
"$NODE_DIR/bin/node" --version
"$NODE_DIR/bin/npm" --version

download "$SQLITE_URL" "$SQLITE_ZIP" "$SQLITE_SHA" "SQLite ${SQLITE_VER}"
if [[ ! -f "$DEPS/sqlite/sqlite3.c" ]]; then
  rm -rf "$DEPS/sqlite.tmp"
  mkdir -p "$DEPS/sqlite.tmp"
  unzip -q "$SQLITE_ZIP" -d "$DEPS/sqlite.tmp"
  rm -rf "$DEPS/sqlite"
  mv "$DEPS/sqlite.tmp/$SQLITE_SRC_NAME" "$DEPS/sqlite"
  rmdir "$DEPS/sqlite.tmp"
fi

mkdir -p "$DEPS/nlohmann"
download "$NLOHMANN_URL" "$DEPS/nlohmann/json.hpp" "$NLOHMANN_SHA" "nlohmann/json ${NLOHMANN_VER}"
if [[ ! -f "$DEPS/nlohmann/LICENSE.MIT" && -f "$ROOT/third_party/licenses/nlohmann-json-LICENSE.MIT" ]]; then
  cp "$ROOT/third_party/licenses/nlohmann-json-LICENSE.MIT" "$DEPS/nlohmann/LICENSE.MIT"
fi

if [[ ! -d "$DEPS/slang-src/.git" ]]; then
  echo "clone slang $SLANG_COMMIT"
  rm -rf "$DEPS/slang-src"
  git init -q "$DEPS/slang-src"
  git -C "$DEPS/slang-src" remote add origin "$SLANG_REPO"
fi
if ! git -C "$DEPS/slang-src" cat-file -e "$SLANG_COMMIT^{commit}" 2>/dev/null; then
  git -C "$DEPS/slang-src" fetch --depth 1 origin "$SLANG_COMMIT"
fi
git -C "$DEPS/slang-src" checkout -q --detach "$SLANG_COMMIT"
[[ "$(git -C "$DEPS/slang-src" rev-parse HEAD)" == "$SLANG_COMMIT" ]] || {
  echo "slang commit mismatch" >&2; exit 1; }

SLANG_CMAKE_DIR=""
for d in "$DEPS/slang/lib64/cmake/slang" "$DEPS/slang/lib/cmake/slang"; do
  if [[ -f "$d/slangConfig.cmake" ]]; then SLANG_CMAKE_DIR="$d"; break; fi
done
if [[ -z "$SLANG_CMAKE_DIR" ]]; then
  echo "configure slang"
  cmake --fresh -S "$DEPS/slang-src" -B "$ROOT/build/slang" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$DEPS/slang" \
    -DSLANG_INCLUDE_TESTS=OFF -DSLANG_INCLUDE_TOOLS=OFF \
    -DSLANG_INCLUDE_DOCS=OFF -DSLANG_INCLUDE_PYLIB=OFF \
    -DSLANG_INCLUDE_INSTALL=ON \
    -DSLANG_USE_MIMALLOC=OFF -DSLANG_USE_SYSTEM_FMT=OFF \
    -DSLANG_USE_SYSTEM_BOOST=OFF -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_C_COMPILER_LAUNCHER= -DCMAKE_CXX_COMPILER_LAUNCHER= \
    -DCCACHE_EXECUTABLE=OFF \
    >"$EVID/slang-configure.log" 2>&1
  echo "build slang -j$JOBS"
  cmake --build "$ROOT/build/slang" --target install -j "$JOBS" \
    >"$EVID/slang-build.log" 2>&1
  for d in "$DEPS/slang/lib64/cmake/slang" "$DEPS/slang/lib/cmake/slang"; do
    if [[ -f "$d/slangConfig.cmake" ]]; then SLANG_CMAKE_DIR="$d"; break; fi
  done
fi

[[ -n "$SLANG_CMAKE_DIR" ]] || {
  echo "slang install missing" >&2; tail -60 "$EVID/slang-build.log" >&2 || true; exit 1; }

echo "install npm dependencies"
"$NODE_DIR/bin/npm" ci --ignore-scripts --no-audit --no-fund \
  --cache "$ROOT/.sandbox/cache/npm" \
  --userconfig "$ROOT/.sandbox/config/npmrc" \
  >"$EVID/npm-ci.log" 2>&1

# Optional: make an already-present Playwright Chromium available to the
# private test profile. Pass the host browser cache as an --input mount; the
# binary is copied into the project and never installed or executed from the
# host cache.
if [[ -d /inputs/ms-playwright ]]; then
  src="$(find /inputs/ms-playwright -maxdepth 3 -type f -name chrome -path '*/chrome-linux64/chrome' 2>/dev/null | head -1)"
  if [[ -n "$src" ]]; then
    mkdir -p "$DEPS/browser"
    rm -rf "$DEPS/browser/chrome-linux64"
    cp -a "$(dirname "$src")" "$DEPS/browser/"
  fi
fi

cat >"$DEPS/deps.lock.json" <<EOF
{
  "source": "tools/deps/versions.json",
  "node": {"version": "$NODE_VER", "platform": "linux-x64", "sha256": "$NODE_SHA"},
  "sqlite": {"version": "$SQLITE_VER", "sha256": "$SQLITE_SHA"},
  "nlohmannJson": {"version": "$NLOHMANN_VER", "sha256": "$NLOHMANN_SHA"},
  "slang": {"commit": "$SLANG_COMMIT", "version": "$(json_value slangVersion)"},
  "npmLock": "$(sha256sum "$ROOT/package-lock.json" | awk '{print $1}')"
}
EOF

echo "bootstrap complete"
