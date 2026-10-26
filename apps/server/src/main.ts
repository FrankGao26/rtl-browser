#!/usr/bin/env node
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

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AllowedRoots } from "../../../packages/core/src/paths.js";
import { BuildManager } from "../../../packages/core/src/buildManager.js";
import { ProjectStore } from "../../../packages/core/src/projectStore.js";
import { QueryManager } from "../../../packages/core/src/queryManager.js";
import { SnapshotStore } from "../../../packages/core/src/snapshotStore.js";
import { FsBrowser } from "./fsBrowser.js";
import { createHttpServer, type HttpContext } from "./httpServer.js";
import { SessionManager } from "./session.js";
import { AppError } from "../../../packages/contracts/src/errors.js";

interface Args {
  workspace: string[];
  web: string;
  worker: string;
  schema: string;
  port: number;
}

function codeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
}

function repoRoot(): string {
  if (process.env.RTL_PROJECT_ROOT) return path.resolve(process.env.RTL_PROJECT_ROOT);
  return codeRoot();
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(codeRoot(), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function workerFileName(): string {
  return process.platform === "win32" ? "index-worker.exe" : "index-worker";
}

function parseArgs(argv: string[]): Args {
  const root = repoRoot();
  const out: Args = {
    workspace: [],
    web: path.join(root, "dist", "web"),
    worker: path.join(root, "build", "index-worker", workerFileName()),
    schema: path.join(root, "contracts", "sql", "schema.sql"),
    port: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace" || a === "--allow-root") out.workspace.push(argv[++i] ?? "");
    else if (a === "--web") out.web = argv[++i] ?? out.web;
    else if (a === "--worker") out.worker = argv[++i] ?? out.worker;
    else if (a === "--schema") out.schema = argv[++i] ?? out.schema;
    else if (a === "--port") out.port = Number(argv[++i] ?? "0");
    else if (a === "--version" || a === "-V") {
      console.log(appVersion());
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      console.log("rtl-browser serve [--workspace DIR]... [--web DIR] [--worker FILE] [--schema FILE] [--port N]");
      process.exit(0);
    } else {
      throw new AppError("INVALID_INPUT", `unknown argument: ${a}`);
    }
  }
  if (!out.workspace.length) out.workspace.push(process.cwd());
  out.workspace = out.workspace.map((p) => path.resolve(p));
  out.web = path.resolve(out.web);
  out.worker = path.resolve(out.worker);
  out.schema = path.resolve(out.schema);
  if (!Number.isSafeInteger(out.port) || out.port < 0 || out.port > 65535) throw new AppError("INVALID_INPUT", "invalid port");
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const roots = new AllowedRoots(args.workspace);
  const sessionId = crypto.randomUUID();
  const projects = new ProjectStore(sessionId);
  const snapshots = new SnapshotStore(projects);
  const builds = new BuildManager(projects, snapshots, args.worker, args.schema);
  const queries = new QueryManager(snapshots);
  const fsBrowser = new FsBrowser(roots);
  let requestExit: () => void = () => {};

  let session: SessionManager | null = null;
  const ctx: HttpContext = {
    projects, snapshots, builds, queries, fs: fsBrowser,
    workspace: { projectRoot: null },
    get session() { return session as SessionManager; },
    requestExit: () => requestExit(),
    webRoot: args.web,
    version: appVersion(),
  };
  const server = createHttpServer(ctx);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new AppError("INTERNAL_ERROR", "cannot determine server port");
  session = new SessionManager(address.port);
  const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(session.bootstrapToken)}`;
  console.log("RTL Browser");
  console.log(`workspace: ${roots.displayRoots.join(", ")}`);
  console.log(`worker: ${args.worker}`);
  console.log(`open: ${url}`);
  console.log("This URL contains a bootstrap token; the browser removes it after setting the session cookie.");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("shutting down...");
    await builds.shutdown();
    await queries.stopAll();
    projects.purgeSessionState();
    projects.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  requestExit = () => { void shutdown(); };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  if (process.platform === "win32") process.on("SIGBREAK", () => { void shutdown(); });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
