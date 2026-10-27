// Copyright 2026 Frank Gao
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const ROOT = process.env.RTL_PROJECT_ROOT ? path.resolve(process.env.RTL_PROJECT_ROOT)
  : path.resolve(import.meta.dirname, "..");
const STATE_PARENT = path.resolve(ROOT, "state");
const STATE = path.resolve(STATE_PARENT, `worker-lifecycle-${Date.now()}-${process.pid}`);
const relativeState = path.relative(STATE_PARENT, STATE);
assert.ok(relativeState && !relativeState.startsWith("..") && !path.isAbsolute(relativeState));
const { BuildManager } = await import(pathToFileURL(path.join(ROOT,
  "dist", "server", "packages", "core", "src", "buildManager.js")));
const { REQUIRED_CAPABILITIES } = await import(pathToFileURL(path.join(ROOT,
  "dist", "server", "packages", "contracts", "src", "types.js")));

const jobs = new Map();
const config = { configRevision: 1, configDigest: "a".repeat(64), workingDirectory: ROOT };
const projects = {
  get: () => ({ config }),
  listJobs: () => [],
  prepareBuild: () => ({ purged: false }),
  jobDir: (_projectId, jobId) => path.join(STATE, jobId),
  writeJob: async (job) => { jobs.set(job.jobId, structuredClone(job)); },
  readJob: (_projectId, jobId) => jobs.get(jobId),
  setActiveJob: () => {},
  pruneSnapshots: () => {},
};
let publications = 0;
const snapshots = {
  publish: async () => { publications++; return { snapshotId: "s_lifecycle" }; },
};
const child = new EventEmitter();
child.stdout = new PassThrough();
child.stderr = new PassThrough();
child.kill = () => true;
const originalSpawn = childProcess.spawn;
const originalConsoleError = console.error;
const diagnostics = [];
// Keep expected manager diagnostics quiet on success; include them in failures.
console.error = (...parts) => { diagnostics.push(parts.map(String).join(" ")); };
childProcess.spawn = () => child;
syncBuiltinESMExports();
try {
  const manager = new BuildManager(projects, snapshots, process.execPath, "schema.sql");
  const job = await manager.start("lifecycle-project", { configRevision: 1 });

  // A process can exit while pipe data is still buffered. Deliver its final
  // artifact frame after exit, then close the pipes and emit close explicitly.
  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(publications, 0, "must not publish before the protocol is drained");
  child.stdout.end(JSON.stringify({
    protocolVersion: 1, jobId: job.jobId, seq: 0, type: "artifact.ready",
    manifestPath: "manifest.json", manifestSha256: "b".repeat(64),
    snapshotId: "s_lifecycle", counts: {},
    capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map((capability) =>
      [capability, { present: true, complete: true, reason: null }])),
  }) + "\n");
  child.stderr.end();
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0, null);

  let finished;
  for (let attempt = 0; attempt < 100; attempt++) {
    finished = manager.job("lifecycle-project", job.jobId);
    if (["COMPLETE", "FAILED"].includes(finished.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(finished.state, "COMPLETE", JSON.stringify(finished) + "\n" + diagnostics.join("\n"));
  assert.equal(finished.snapshotId, "s_lifecycle");
  assert.equal(publications, 1, "publish the drained artifact exactly once");
  console.log("worker-lifecycle: PASS (exit before final stdout frame)");
} finally {
  console.error = originalConsoleError;
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  child.stdout.destroy();
  child.stderr.destroy();
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
