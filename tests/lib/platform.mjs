// Copyright 2026 Frank Gao
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export function workerExecutable(root) {
  if (process.env.RTL_WORKER) return path.resolve(process.env.RTL_WORKER);
  return path.join(root, "build", "index-worker", IS_WINDOWS ? "index-worker.exe" : "index-worker");
}

export function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

export async function stopServer(child, requestExit) {
  try {
    if (requestExit) await requestExit();
  } catch {
    // Fall back to signal/termination below.
  }
  await waitForExit(child, 3000);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch { /* ignore */ }
    await waitForExit(child, 3000);
  }
}
