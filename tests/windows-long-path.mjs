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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stopServer, workerExecutable } from "./lib/platform.mjs";

if (process.platform !== "win32") {
  console.log("windows-long-path: SKIP (Windows only)");
  process.exit(0);
}

const ROOT = process.env.RTL_PROJECT_ROOT ? path.resolve(process.env.RTL_PROJECT_ROOT)
  : path.resolve(import.meta.dirname, "..");
const STATE_PARENT = path.resolve(ROOT, "state");
const STATE = path.resolve(STATE_PARENT, `long-path-${Date.now()}-${process.pid}`);
const relativeState = path.relative(STATE_PARENT, STATE);
assert.ok(relativeState && !relativeState.startsWith("..") && !path.isAbsolute(relativeState));
// Make source blobs exceed MAX_PATH while keeping shorter job metadata paths
// within MAX_PATH, so the regression exercises the source-blob I/O boundary.
const projectDir = path.join(STATE, "project-" + "p".repeat(Math.max(12, 112 - STATE.length - 9)));
fs.cpSync(path.join(ROOT, "tests", "fixtures", "simple"), projectDir, {
  recursive: true, filter: (src) => path.basename(src) !== ".rtlb",
});
const server = spawn(process.execPath, [
  path.join(ROOT, "dist", "server", "apps", "server", "src", "main.js"),
  "--workspace", STATE, "--worker", workerExecutable(ROOT), "--port", "0",
], {
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, RTL_PROJECT_ROOT: ROOT },
});
let stderr = "";
server.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-20000); });
let api;
try {
  const url = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`server startup timed out\n${stderr}`)), 15000);
    server.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((item) => item.startsWith("open: "));
      if (line) { clearTimeout(timer); resolve(line.slice(6).trim()); }
    });
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr}`));
    });
  });
  const base = new URL(url).origin;
  const boot = await fetch(url, { redirect: "manual" });
  assert.equal(boot.status, 303);
  const cookie = (boot.headers.get("set-cookie") || "").split(";")[0];
  const session = await fetch(`${base}/api/session`, { headers: { cookie } }).then((r) => r.json());
  assert.equal(session.ok, true);
  api = async (method, route, body) => {
    const headers = { cookie, origin: base, "x-rtl-csrf": session.data.csrfToken };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${base}${route}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  await api("POST", "/api/workspace/open", { path: projectDir });
  const created = await api("POST", "/api/projects", { config: {
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule: "top",
    defines: [], includeRoots: [], libraries: [], parameters: [],
    language: "1800-2017", singleUnit: false, threads: 1, warningAsError: false, warningOptions: [],
  } });
  const projectId = created.project.projectId;
  const started = await api("POST", `/api/projects/${projectId}/build`, {
    configRevision: 1, requestKey: "windows-long-path",
  });
  let job;
  for (let attempt = 0; attempt < 300; attempt++) {
    job = await api("GET", `/api/projects/${projectId}/jobs/${started.jobId}`);
    if (["COMPLETE", "FAILED", "CANCELLED"].includes(job.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.state, "COMPLETE", JSON.stringify(job, null, 2) + "\n" + stderr);
  const sessions = path.join(projectDir, ".rtlb", "sessions");
  const sessionNames = fs.readdirSync(sessions);
  assert.equal(sessionNames.length, 1);
  const snapshotDir = path.join(sessions, sessionNames[0], "snapshots", job.snapshotId);
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"));
  assert.ok(manifest.sources.length >= 2);
  let longest = 0;
  for (const source of manifest.sources) {
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!source.displayPath.includes("\\\\?\\"), "I/O prefix leaked into snapshot metadata");
    const blob = path.join(snapshotDir, "sources", `${source.sha256}.bin`);
    assert.ok(blob.length > 260, `regression path must exceed MAX_PATH: ${blob.length}`);
    const bytes = fs.readFileSync(blob);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), source.sha256);
    assert.deepEqual(bytes, fs.readFileSync(path.join(projectDir, source.displayPath)));
    longest = Math.max(longest, blob.length);
  }
  const hierarchy = await api("GET", `/api/projects/${projectId}/snapshots/${job.snapshotId}/hierarchy/children`);
  const top = hierarchy.records[0];
  const source = await api("GET", `/api/projects/${projectId}/snapshots/${job.snapshotId}/source?sourceId=${top.definitionSourceId}&instanceId=${top.id}&startLine=1`);
  assert.ok(source.lines.some((line) => line.text.includes("assign a8")));
  console.log(`windows-long-path: PASS; published blob path length=${longest}`);
} finally {
  await stopServer(server, async () => { if (api) await api("POST", "/api/app/exit"); });
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
