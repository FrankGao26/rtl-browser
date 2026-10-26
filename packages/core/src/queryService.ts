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

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppError } from "../../contracts/src/errors.js";
import { LIMITS } from "../../contracts/src/limits.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const QUERY_CHILD = fileURLToPath(new URL("../../storage/src/query-child.js", import.meta.url));

export class QueryService {
  readonly snapshotDir: string;
  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private stderr = "";

  constructor(snapshotDir: string) {
    this.snapshotDir = snapshotDir;
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.connected && !this.child.killed) return this.child;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: process.env.PATH ?? process.env.Path ?? "",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TMPDIR: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "",
    };
    if (process.platform === "win32") delete env.Path;
    const child = fork(QUERY_CHILD, [this.snapshotDir], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
      env,
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.on("message", (msg: { id?: number; ok?: boolean; data?: unknown; error?: { code?: string; message?: string }; type?: string }) => {
      if (!msg || typeof msg.id !== "number") return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new AppError((msg.error?.code as never) ?? "INTERNAL_ERROR", msg.error?.message ?? "query failed"));
    });
    child.on("exit", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AppError("INTERNAL_ERROR", "query process exited"));
      }
      this.pending.clear();
      if (this.child === child) this.child = null;
    });
    child.on("error", () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
    return child;
  }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = LIMITS.queryTimeoutMs): Promise<T> {
    if (this.pending.size >= LIMITS.queryQueueDepth) {
      return Promise.reject(new AppError("QUERY_LIMIT", "query queue is full", { retryable: true }));
    }
    const child = this.ensureChild();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError("QUERY_TIMEOUT", `query timed out: ${method}`, { retryable: true }));
        // The synchronous SQLite call may be stuck; kill only this owned child.
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        if (this.child === child) this.child = null;
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        child.send({ id, method, params }, (err) => {
          if (!err) return;
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          clearTimeout(p.timer);
          reject(new AppError("INTERNAL_ERROR", `query process send failed: ${err.message}`, { retryable: true }));
        });
      } catch (err) {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          clearTimeout(p.timer);
        }
        reject(new AppError("INTERNAL_ERROR", `query process unavailable: ${err instanceof Error ? err.message : String(err)}`, { retryable: true }));
      }
    });
  }

  diagnosticTail(): string {
    return this.stderr;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AppError("CANCELLED", "query service stopped"));
    }
    this.pending.clear();
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 3000);
    timer.unref?.();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3500).unref?.())]);
    clearTimeout(timer);
  }
}
