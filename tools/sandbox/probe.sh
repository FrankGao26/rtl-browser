#!/bin/sh
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

# Read-only/mount/environment probe executed inside bwrap by verify-isolation.sh.
set -u

say() { printf '%s=%s\n' "$1" "$2"; }
ok() { printf 'ok:%s\n' "$1"; }
bad() { printf 'bad:%s\n' "$1"; }

say profile "${RTL_PROFILE:-?}"
say network "${RTL_NETWORK:-?}"
say pwd "$(pwd)"
say home "$HOME"
say tmpdir "${TMPDIR:-}"
say path "${PATH:-}"

# The host home is replaced by an empty tmpfs; the private HOME lives under /work.
if [ -d /home ] && [ -z "$(find /home -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
  ok host_home_hidden
else
  bad host_home_hidden
fi
[ ! -e /mnt/c ] && ok mnt_c_hidden || bad mnt_c_hidden
[ ! -e /run/user ] && ok run_user_hidden || bad run_user_hidden
[ -e /work/tools/sandbox/rtl-bwrap ] && ok project_visible || bad project_visible
[ -e /inputs ] && ok inputs_dir || bad inputs_dir

# Source is mounted read-only in build/test profiles.
if printf 'x\n' > /work/tools/sandbox/.canary-source 2>/dev/null; then
  bad source_readonly
else
  ok source_readonly
fi

# Build/state are writable.
if printf 'x\n' > /work/build/.canary-build 2>/dev/null; then
  ok build_writable
else
  bad build_writable
fi

# A private HOME must be writable and must be under /work/.sandbox.
if printf 'x\n' > "$HOME/.canary-home" 2>/dev/null; then
  ok private_home_writable
else
  bad private_home_writable
fi

# The host filesystem must not be writable through an exposed path.
if printf 'x\n' > /mnt/c/.rtl-browser-canary 2>/dev/null; then
  bad host_write_blocked
else
  ok host_write_blocked
fi

# Sensitive inherited variables must be absent.
if env | grep -Eq '^(SSH_AUTH_SOCK|DOCKER_HOST|DISPLAY|WAYLAND_DISPLAY|WSL_INTEROP)='; then
  bad sensitive_env_absent
else
  ok sensitive_env_absent
fi

# Project-private tool locations.
say node "$(command -v node 2>/dev/null || echo missing)"
say npm "$(command -v npm 2>/dev/null || echo missing)"
say cmake "$(command -v cmake 2>/dev/null || echo missing)"
say gxx "$(command -v g++ 2>/dev/null || echo missing)"
say ninja "$(command -v ninja 2>/dev/null || echo missing)"
say git "$(command -v git 2>/dev/null || echo missing)"

if [ "${RTL_NETWORK:-}" = "online" ]; then
  if curl -fsSI --max-time 8 https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz >/dev/null 2>&1; then
    ok online_https
  else
    bad online_https
  fi
else
  if curl -fsSI --max-time 5 https://nodejs.org/ >/dev/null 2>&1; then
    bad offline_egress_blocked
  else
    ok offline_egress_blocked
  fi
fi

# Loopback must work in both modes.
if python3 - <<'PY' >/dev/null 2>&1
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(1)
port = s.getsockname()[1]
c = socket.create_connection(("127.0.0.1", port), timeout=2)
a, _ = s.accept()
a.close()
c.close()
s.close()
PY
then
  ok loopback
else
  bad loopback
fi

# Report the visible mount set without dumping host-private paths.
echo 'mounts_begin'
grep -E ' /(work|inputs|home|tmp|proc|dev|usr|sys|run) ' /proc/self/mountinfo 2>/dev/null | head -40 || true
echo 'mounts_end'
echo 'env_begin'
env | sort | grep -Ev '^(HOME|PATH|TMPDIR|TMP|TEMP|PWD|OLDPWD|SHLVL|_|LS_COLORS)=' | head -40 || true
echo 'env_end'
