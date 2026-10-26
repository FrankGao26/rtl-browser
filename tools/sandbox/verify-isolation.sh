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

# T01 isolation evidence runner. Runs the project-private probe in bwrap and
# records mount/environment/network/write-boundary results.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PROJECT="${RTL_PROJECT:-$ROOT}"
MODE="both"

while (($#)); do
  case "$1" in
    --network) MODE="${2:?}"; shift 2 ;;
    --project) PROJECT="${2:?}"; shift 2 ;;
    -h|--help) echo "usage: $0 [--network online|offline|both] [--project DIR]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in online|offline|both) ;; *) echo "bad network mode: $MODE" >&2; exit 2 ;; esac
PROJECT="$(cd -- "$PROJECT" && pwd -P)"
mkdir -p "$PROJECT/.sandbox/evidence" "$PROJECT/.sandbox/tmp" "$PROJECT/build" "$PROJECT/tools/sandbox"

CANARY="$PROJECT/tools/sandbox/.canary-source"
BUILD_CANARY="$PROJECT/build/.canary-build"
printf 'source-canary\n' >"$CANARY"
rm -f "$BUILD_CANARY"

cleanup() {
  rm -f "$CANARY" "$BUILD_CANARY"
  rm -f "$PROJECT/.sandbox/tmp"/rtl-evidence-*.txt "$PROJECT/.sandbox/tmp"/rtl-evidence-*.json
}
trap cleanup EXIT

host_baseline() {
  if command -v dpkg-query >/dev/null 2>&1; then
    dpkg-query -W -f='${Package} ${Version}\n' 2>/dev/null | sha256sum | awk '{print $1}'
  else
    printf 'unavailable\n'
  fi
}
pkg_before="$(host_baseline)"
source_before="$(sha256sum "$CANARY" | awk '{print $1}')"

run_mode() {
  local mode="$1" out="$2" rc=0
  if ! "$PROJECT/tools/sandbox/rtl-bwrap" --profile test --network "$mode" -- \
       /work/tools/sandbox/probe.sh >"$out" 2>&1; then
    rc=$?
  fi
  local bad=0 ok=0
  bad="$(grep -c '^bad:' "$out" 2>/dev/null || true)"
  ok="$(grep -c '^ok:' "$out" 2>/dev/null || true)"
  if (( rc != 0 || bad != 0 )); then
    return 1
  fi
  printf '%s\n' "$rc" >"${out%.txt}.rc"
  printf '%s\n' "$ok" >"${out%.txt}.ok"
  printf '%s\n' "$bad" >"${out%.txt}.bad"
  return 0
}

status=0
for mode in online offline; do
  [[ "$MODE" == "both" || "$MODE" == "$mode" ]] || continue
  out="$PROJECT/.sandbox/tmp/rtl-evidence-$mode.txt"
  if run_mode "$mode" "$out"; then
    echo "isolation $mode: PASS"
  else
    echo "isolation $mode: FAIL" >&2
    status=1
  fi
done

pkg_after="$(host_baseline)"
source_after="$(sha256sum "$CANARY" 2>/dev/null | awk '{print $1}' || echo missing)"
if [[ "$pkg_before" != "$pkg_after" ]]; then
  echo "host package database digest changed" >&2
  status=1
fi
if [[ "$source_before" != "$source_after" ]]; then
  echo "source canary changed" >&2
  status=1
fi

# Write a compact, local evidence document. It deliberately contains only
# sandbox paths and sanitized probe output, not host HOME paths.
python3 - "$PROJECT" "$MODE" "$pkg_before" "$pkg_after" "$status" <<'PY'
import json, os, platform, subprocess, sys, time
project, mode, pkg_before, pkg_after, status = sys.argv[1:6]
probe = {}
for m in ("online", "offline"):
    p = os.path.join(project, ".sandbox", "tmp", f"rtl-evidence-{m}.txt")
    if os.path.exists(p):
        with open(p, encoding="utf-8", errors="replace") as f:
            # The mountinfo line contains the host project path; normalize it
            # so evidence can be shared without a local path or user name.
            probe[m] = f.read().replace(project, "/work")
try:
    bwrap_version = subprocess.check_output(["bwrap", "--version"], text=True).strip()
except Exception:
    bwrap_version = "unknown"
doc = {
    "kind": "T01-isolation-evidence",
    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "mode": mode,
    "status": "PASS" if int(status) == 0 else "FAIL",
    "platform": {"system": platform.system(), "release": platform.release(),
                 "machine": platform.machine()},
    "bwrap": bwrap_version,
    "hostPackageDigestBefore": pkg_before,
    "hostPackageDigestAfter": pkg_after,
    "hostPackageDatabaseUnchanged": pkg_before == pkg_after,
    "project": "/work",
    "probe": probe,
    "limits": [
        "This probe verifies the selected bwrap mount/environment profile; it is not a malicious-code sandbox guarantee.",
        "Host package digest read is a coarse baseline, not a byte-for-byte host audit.",
        "No new RTL or performance test is performed here."
    ],
}
out = os.path.join(project, ".sandbox", "evidence", f"isolation-{mode}-{int(time.time())}.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
latest = os.path.join(project, ".sandbox", "evidence", "isolation-latest.json")
with open(latest, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(out)
PY

exit "$status"
