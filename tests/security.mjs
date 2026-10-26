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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { workerExecutable } from "./lib/platform.mjs";

if (process.platform === "win32") {
  console.log("security: SKIP (POSIX permission/symlink cases are tested on Linux)");
  process.exit(0);
}

const ROOT = process.env.RTL_PROJECT_ROOT ? path.resolve(process.env.RTL_PROJECT_ROOT) : path.resolve(import.meta.dirname, "..");
const MAIN = path.join(ROOT, "dist", "server", "apps", "server", "src", "main.js");
const WORKER = workerExecutable(ROOT);
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const STATE = path.join(ROOT, "state", `security-${Date.now()}-${process.pid}`);
const ESCAPE_ROOT = path.join(STATE, "escape-root");
const HOST = "127.0.0.1";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
fs.mkdirSync(ESCAPE_ROOT, { recursive: true });
fs.symlinkSync("/etc", path.join(ESCAPE_ROOT, "host-etc"));

const server = spawn(process.execPath, [
  MAIN, "--workspace", STATE, "--worker", WORKER,
  "--web", path.join(ROOT, "dist", "web"), "--port", "0",
], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, RTL_PROJECT_ROOT: ROOT },
});
let stderr = "";
server.stderr.on("data", (c) => { stderr = (stderr + c.toString()).slice(-20000); });
const urlLine = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error(`server did not start\n${stderr}`)), 15000);
  server.stdout.on("data", (c) => {
    buf += c.toString();
    const line = buf.split("\n").find((x) => x.startsWith("open: "));
    if (line) { clearTimeout(timer); resolve(line.slice(6).trim()); }
  });
  server.on("exit", (code) => { if (code !== null) reject(new Error(`server exited ${code}\n${stderr}`)); });
});
const parsed = new URL(urlLine);
const base = `http://${HOST}:${parsed.port}`;
const origin = base;
const boot = await fetch(urlLine, { redirect: "manual" });
assert.equal(boot.status, 303);
const cookie = (boot.headers.get("set-cookie") || "").split(";")[0];
assert.match(cookie, /^rtl_sid_\d+=/);

async function raw(method, p, { body, headers = {}, token = true } = {}) {
  const h = { origin, ...headers };
  if (token) h.cookie = cookie;
  if (body !== undefined && h["content-type"] === undefined) h["content-type"] = "application/json";
  if (method !== "GET" && token && h["x-rtl-csrf"] === undefined) h["x-rtl-csrf"] = csrf;
  const res = await fetch(`${base}${p}`, {
    method, headers: h, redirect: "manual",
    body: body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  return { res, text: await res.text() };
}
const sessionRes = await raw("GET", "/api/session");
assert.equal(sessionRes.res.status, 200);
const sessionData = JSON.parse(sessionRes.text).data;
const csrf = sessionData.csrfToken;
const sessionRoots = sessionData.roots;

function statusWithHost(host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: parsed.port, path: "/api/projects", method: "GET", headers: { Host: host, cookie } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}
async function json(method, p, body, opts = {}) {
  const r = await raw(method, p, { body, ...opts });
  return { status: r.res.status, body: JSON.parse(r.text) };
}
async function ok(method, p, body) {
  const r = await json(method, p, body);
  if (!r.body.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
function projectCopy(name, fixture) {
  const dir = path.join(STATE, "projects", `${name}-${Date.now()}`);
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true, filter: (src) => path.basename(src) !== ".rtlb" });
  return dir;
}
async function createProject(name, fixture, topModule = "top") {
  const dir = projectCopy(name, fixture);
  await ok("POST", "/api/workspace/open", { path: dir });
  const config = {
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule,
    defines: [], includeRoots: [], libraries: [], parameters: [], language: "1800-2017",
    singleUnit: false, threads: 1, warningAsError: false, warningOptions: [],
  };
  return (await ok("POST", "/api/projects", { config })).project;
}
function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function currentSessionDir(projectRoot) {
  const sessions = path.join(projectRoot, ".rtlb", "sessions");
  const dirs = fs.readdirSync(sessions).filter((name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(sessions, name, "session.json"), "utf8")).pid === server.pid;
    } catch { return false; }
  });
  assert.equal(dirs.length, 1);
  return path.join(sessions, dirs[0]);
}
async function downloadBinary(p, headers = {}) {
  const res = await fetch(`${base}${p}`, { headers: { cookie, ...headers } });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}
async function importRaw(dir, body, headers) {
  await ok("POST", "/api/workspace/open", { path: dir });
  return raw("POST", "/api/workspace/snapshot/import", { body, headers });
}
async function build(projectId, key) {
  const job = await ok("POST", `/api/projects/${projectId}/build`, { configRevision: 1, requestKey: key });
  for (let i = 0; i < 150; i++) {
    const j = await ok("GET", `/api/projects/${projectId}/jobs/${job.jobId}`);
    if (["COMPLETE", "FAILED", "CANCELLED"].includes(j.state)) return j;
    await sleep(100);
  }
  throw new Error("build did not finish");
}

try {
  // Authentication and request authenticity
  assert.equal((await raw("GET", "/api/projects", { token: false })).res.status, 403);
  assert.equal(await statusWithHost("evil.example"), 403);
  assert.equal((await raw("POST", "/api/projects", { body: {}, headers: { origin: "http://evil.example", "x-rtl-csrf": csrf } })).res.status, 403);
  assert.equal((await raw("POST", "/api/projects", { body: {}, headers: { "x-rtl-csrf": "" } })).res.status, 403);

  const replay = await fetch(urlLine, { redirect: "manual" });
  assert.notEqual(replay.status, 303);
  assert.equal(replay.headers.get("set-cookie"), null);

  const index = await raw("GET", "/", { token: false });
  assert.equal(index.res.status, 200);
  assert.equal(index.res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(index.res.headers.get("referrer-policy"), "no-referrer");
  assert.match(index.res.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.match(index.res.headers.get("content-security-policy") || "", /script-src 'self'/);

  // Browse boundary and symlink escape
  assert.equal((await raw("GET", "/api/paths?path=/etc")).res.status, 403);
  assert.equal((await raw("GET", `/api/paths?path=${encodeURIComponent(path.join(ESCAPE_ROOT, "host-etc"))}`)).res.status, 403);
  const rootListing = JSON.parse((await raw("GET", `/api/paths?path=${encodeURIComponent(ESCAPE_ROOT)}`)).text);
  assert.equal(rootListing.ok, true);
  assert.ok(!rootListing.data.entries.some((e) => e.name === "host-etc"));

  // Oversized requests
  const huge = "x".repeat(70 * 1024);
  assert.equal((await raw("POST", "/api/workspace/open", { body: `{"path":"${huge}"}` })).res.status, 413);

  // Opening a read-only or non-writable project folder is rejected
  const readonly = path.join(STATE, "readonly-project");
  fs.mkdirSync(readonly, { recursive: true });
  fs.chmodSync(readonly, 0o500);
  const deniedOpen = await json("POST", "/api/workspace/open", { path: readonly });
  fs.chmodSync(readonly, 0o700);
  assert.equal(deniedOpen.status, 403);

  const blockedState = path.join(STATE, "blocked-state");
  fs.mkdirSync(path.join(blockedState, ".rtlb"), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(blockedState, ".rtlb"), 0o500);
  const blocked = await json("POST", "/api/workspace/open", { path: blockedState });
  fs.chmodSync(path.join(blockedState, ".rtlb"), 0o700);
  assert.equal(blocked.status, 403);

  // Successful build uses hidden project state and relative responses
  const simple = await createProject("security-simple", "simple");
  const job = await build(simple.projectId, "security-simple");
  assert.equal(job.state, "COMPLETE");
  const snaps = await ok("GET", `/api/projects/${simple.projectId}/snapshots`);
  const sid = snaps[0].snapshotId;
  const root = (await ok("GET", `/api/projects/${simple.projectId}/snapshots/${sid}/hierarchy/children`)).records[0];
  const src = await raw("GET", `/api/projects/${simple.projectId}/snapshots/${sid}/source?sourceId=${root.definitionSourceId}&instanceId=${root.id}&startLine=1`);
  assert.equal(src.res.status, 200);
  assert.ok(src.text.includes('"displayPath":"top.sv"'));
  for (const secret of [FIXTURES, ROOT, ...sessionRoots]) {
    assert.ok(!src.text.includes(secret), `source response leaked ${secret}`);
  }
  const stateDir = path.join(simple.projectRoot, ".rtlb");
  const sessionDir = currentSessionDir(simple.projectRoot);
  assert.ok(isWithin(stateDir, sessionDir));
  assert.ok(fs.existsSync(path.join(sessionDir, "project.json")));
  assert.ok(fs.existsSync(path.join(sessionDir, "snapshots", sid, "index.sqlite")));
  assert.ok(!fs.existsSync(path.join(stateDir, "project.json")), "no legacy root-level state is written");
  const hiddenState = await raw("GET", `/api/paths?path=${encodeURIComponent(stateDir)}`);
  assert.equal(hiddenState.res.status, 400);

  // Snapshot bundle endpoints keep the same authentication boundary.
  const exportPath = `/api/projects/${simple.projectId}/snapshots/${sid}/export?filename=security`;
  assert.equal((await downloadBinary(exportPath, { cookie: "" })).res.status, 403);
  const exported = await downloadBinary(exportPath);
  assert.equal(exported.res.status, 200);
  assert.equal(exported.res.headers.get("content-type"), "application/vnd.rtlb.snapshot");
  const importedDir = path.join(STATE, "projects", `import-security-${Date.now()}`);
  fs.mkdirSync(importedDir, { recursive: true });
  await ok("POST", "/api/workspace/open", { path: importedDir });
  const importUrl = "/api/workspace/snapshot/import";
  const noSession = await fetch(`${base}${importUrl}`, {
    method: "POST",
    headers: { origin, "content-type": "application/octet-stream", "x-rtl-csrf": csrf },
    body: exported.body,
  });
  assert.equal(noSession.status, 403);
  const noCsrf = await fetch(`${base}${importUrl}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/octet-stream" },
    body: exported.body,
  });
  assert.equal(noCsrf.status, 403);
  const wrongType = await raw("POST", importUrl, { body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(wrongType.res.status, 400);
  const wrongOrigin = await raw("POST", importUrl, {
    body: exported.body,
    headers: { origin: "http://evil.example", "content-type": "application/octet-stream" },
  });
  assert.equal(wrongOrigin.res.status, 403);
  const badBundle = Buffer.from(exported.body);
  badBundle[0] = 0x00;
  const rejected = await importRaw(importedDir, badBundle, { "content-type": "application/octet-stream" });
  assert.equal(rejected.res.status, 400);
  assert.equal(JSON.parse(rejected.text).error.code, "INVALID_INPUT");
  assert.equal((await ok("GET", "/api/workspace")).project, null);
  // The legacy whole-.rtlb reset endpoint must be gone.
  assert.equal((await raw("POST", "/api/workspace/reset", { body: { path: importedDir } })).res.status, 400);
  // A symlinked sessions directory is rejected instead of followed.
  const symlinkProject = path.join(STATE, "symlink-session-project");
  fs.mkdirSync(path.join(symlinkProject, ".rtlb"), { recursive: true });
  fs.symlinkSync("/etc", path.join(symlinkProject, ".rtlb", "sessions"));
  assert.equal((await json("POST", "/api/workspace/open", { path: symlinkProject })).status, 403);
  const diag = await raw("GET", `/api/projects/${simple.projectId}/jobs/${job.jobId}/diagnostics`);
  assert.ok(!diag.text.includes(simple.projectRoot));

  const dotSnapshot = await raw("GET", `/api/projects/${simple.projectId}/snapshots/%252e%252e/info`);
  assert.equal(dotSnapshot.res.status, 400);
  const dotJob = await raw("GET", `/api/projects/${simple.projectId}/jobs/%252e%252e`);
  assert.equal(dotJob.res.status, 400);

  // Failed build cannot be queried as a snapshot
  const broken = await createProject("security-broken", "broken", "broken");
  const brokenJob = await build(broken.projectId, "security-broken");
  assert.equal(brokenJob.state, "FAILED");
  assert.equal(brokenJob.snapshotId, null);
  assert.equal((await ok("GET", `/api/projects/${broken.projectId}/snapshots`)).length, 0);
  const missing = await raw("GET", `/api/projects/${broken.projectId}/snapshots/s_deadbeefdeadbeef/info`);
  assert.ok([403, 404, 409].includes(missing.res.status), `unexpected failed-snapshot status ${missing.res.status}`);

  console.log("security: PASS");
} finally {
  server.kill("SIGTERM");
  await sleep(500);
  fs.rmSync(STATE, { recursive: true, force: true });
}
