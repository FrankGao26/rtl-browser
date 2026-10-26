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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { workerExecutable } from "./lib/platform.mjs";

const ROOT = process.env.RTL_PROJECT_ROOT ? path.resolve(process.env.RTL_PROJECT_ROOT) : path.resolve(import.meta.dirname, "..");
const MAIN = path.join(ROOT, "dist", "server", "apps", "server", "src", "main.js");
const WORKER = workerExecutable(ROOT);
const EXAMPLES = path.join(ROOT, "examples");
const STATE = path.join(ROOT, "state", `public-${Date.now()}-${process.pid}`);
const PROJECT = path.join(STATE, "axi-crossbar");
const NETWORK_MODE = process.env.RTL_NETWORK === "offline" ? "offline" : "online";
const EVIDENCE = path.join(ROOT, ".sandbox", "evidence", `public-smoke-${NETWORK_MODE}.json`);
const EVIDENCE_LATEST = path.join(ROOT, ".sandbox", "evidence", "public-smoke.json");
const HOST = "127.0.0.1";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hashTree(dir) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === ".rtlb") continue;
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(path.relative(dir, p)).update("\0").update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}
function currentSessionDir(projectRoot) {
  const sessions = path.join(projectRoot, ".rtlb", "sessions");
  for (const name of fs.readdirSync(sessions)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessions, name, "session.json"), "utf8"));
      if (meta.pid === server.pid) return path.join(sessions, name);
    } catch { /* skip malformed */ }
  }
  throw new Error(`session directory not found under ${sessions}`);
}
function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) total += dirSize(p);
    else if (name.isFile()) total += fs.statSync(p).size;
  }
  return total;
}
function childWorkerPids() {
  try {
    return fs.readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map(Number)
      .filter((pid) => {
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          return cmd.includes("index-worker") && cmd.includes("--job-id");
        } catch { return false; }
      });
  } catch { return []; }
}
function peakRssKb() {
  let peak = 0;
  for (const pid of childWorkerPids()) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const hwm = /^VmHWM:\s+(\d+) kB/m.exec(status);
      const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
      peak = Math.max(peak, Number(hwm?.[1] ?? rss?.[1] ?? 0));
    } catch { /* process exited */ }
  }
  return peak;
}

fs.mkdirSync(STATE, { recursive: true });
fs.cpSync(path.join(EXAMPLES, "axi-crossbar"), PROJECT, { recursive: true, filter: (src) => path.basename(src) !== ".rtlb" });
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
const boot = await fetch(urlLine, { redirect: "manual" });
const cookie = (boot.headers.get("set-cookie") || "").split(";")[0];
const origin = base;

async function api(method, p, body, csrf) {
  const headers = { cookie, origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-rtl-csrf"] = csrf;
  const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 500)}`); }
  if (!j.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 1000)}`);
  return j.data;
}

const sourceBefore = hashTree(PROJECT);
try {
  const session = await api("GET", "/api/session");
  const csrf = session.csrfToken;
  await api("POST", "/api/workspace/open", { path: PROJECT }, csrf);
  const config = {
    inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule: "axi_crossbar",
    defines: [], includeRoots: [], libraries: [], parameters: [],
    language: "1800-2017", singleUnit: false, threads: 4, warningAsError: false, warningOptions: [],
  };
  const project = (await api("POST", "/api/projects", { config }, csrf)).project;

  const started = performance.now();
  const job = await api("POST", `/api/projects/${project.projectId}/build`, { configRevision: 1, requestKey: `public-${Date.now()}` }, csrf);
  let peakRss = 0, final = null;
  for (let i = 0; i < 1200; i++) {
    peakRss = Math.max(peakRss, peakRssKb());
    final = await api("GET", `/api/projects/${project.projectId}/jobs/${job.jobId}`);
    if (["COMPLETE", "FAILED", "CANCELLED"].includes(final.state)) break;
    await sleep(100);
  }
  const buildSeconds = (performance.now() - started) / 1000;
  if (final?.state !== "COMPLETE") {
    const diag = await api("GET", `/api/projects/${project.projectId}/jobs/${job.jobId}/diagnostics`);
    console.error("AXI diagnostics:", JSON.stringify(diag.records.slice(0, 20), null, 2));
  }
  assert.equal(final?.state, "COMPLETE", `AXI build did not complete: ${JSON.stringify(final)}\n${stderr}`);
  assert.ok(final.snapshotId);

  const q0 = performance.now();
  const snaps = await api("GET", `/api/projects/${project.projectId}/snapshots`);
  const sid = snaps[0].snapshotId;
  const roots = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/children`);
  assert.ok(roots.records.length >= 1);
  const firstQueryMs = performance.now() - q0;

  // Breadth-first walk of the published tree, capped for predictable test time.
  const seen = [];
  const queue = [null];
  while (queue.length && seen.length < 5000) {
    const parent = queue.shift();
    let cursor = null;
    do {
      const page = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/hierarchy/children?${parent ? `parentId=${parent}&` : ""}limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...page.records);
      cursor = page.nextCursor;
      if (page.complete) break;
    } while (cursor);
    for (const rec of seen) {
      if (rec.hasChildren && !seen.some((x) => x.id === rec.id && x._queued)) {
        rec._queued = true;
        queue.push(rec.id);
      }
    }
  }
  const totalInstances = seen.length;
  const root = roots.records[0];
  const source = await api("GET", `/api/projects/${project.projectId}/snapshots/${sid}/source?sourceId=${root.definitionSourceId}&instanceId=${root.id}&startLine=1`);
  assert.ok(source.refs.length > 0, "source window has semantic refs");
  assert.equal(source.complete, true, "source window should cover the full file in this smoke test");
  const db = dirSize(path.join(currentSessionDir(PROJECT), "snapshots", sid));
  const metrics = {
    design: "public verilog-axi axi_crossbar (4x4 defaults)",
    upstreamCommit: "516bd5dadc3365b7f9e225d2af8fe0b8d804fe53",
    buildSeconds: Number(buildSeconds.toFixed(3)),
    workerPeakRssMiB: Number((peakRss / 1024).toFixed(1)),
    snapshotBytes: db,
    firstQueryMs: Number(firstQueryMs.toFixed(1)),
    instancesWalked: totalInstances,
    counts: final.counts,
    diagnostics: final.diagnostics,
    note: "medium-design smoke only; not a 120-second or full-scale qualification",
  };
  assert.equal(hashTree(PROJECT), sourceBefore, "example source tree changed during build");
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(metrics, null, 2) + "\n");
  fs.writeFileSync(EVIDENCE_LATEST, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`public-smoke: PASS ${JSON.stringify(metrics)}`);
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(STATE, { recursive: true, force: true });
}
