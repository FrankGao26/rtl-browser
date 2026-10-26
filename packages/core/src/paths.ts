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

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../contracts/src/errors.js";

export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(pathKey(root), pathKey(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function readonlyMode(): number {
  // Windows turns mode 0444 into the read-only attribute, which blocks later
  // snapshot deletion while a query process or antivirus briefly holds a handle.
  return process.platform === "win32" ? 0o600 : 0o444;
}

function clearReadonly(target: string): void {
  if (process.platform !== "win32") return;
  try {
    const st = fs.lstatSync(target);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      // Never recurse through a junction or symlink: changing permissions
      // through it could affect files outside the snapshot/session directory.
      if (normalizeNativePath(fs.realpathSync.native(target)) !== target) return;
      for (const name of fs.readdirSync(target)) clearReadonly(path.join(target, name));
      fs.chmodSync(target, 0o700);
    } else if (!st.isSymbolicLink()) {
      fs.chmodSync(target, 0o600);
    }
  } catch {
    // Best effort; the actual removal reports the useful error.
  }
}

export function rmSyncRetry(target: string, options: fs.RmOptions = {}): void {
  clearReadonly(target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100, ...options });
}

export async function rmRetry(target: string, options: fs.RmOptions = {}): Promise<void> {
  clearReadonly(target);
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100, ...options });
}

export function normalizeNativePath(p: string): string {
  if (process.platform !== "win32") return p;
  // Node's native realpath can return an extended-length prefix. Keeping it in
  // UI/query paths breaks simple path.relative/isWithin checks and looks alien
  // to users, so strip it while retaining the resolved long path.
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

export function canonicalExisting(p: string, label = "path"): string {
  try {
    return normalizeNativePath(fs.realpathSync.native(p));
  } catch {
    throw new AppError("INVALID_INPUT", `${label} does not exist or is not accessible`);
  }
}

export class AllowedRoots {
  /** Canonical roots in CLI order, used for display and default selection. */
  readonly displayRoots: string[];
  /** Canonical roots sorted longest-first for containment checks. */
  readonly roots: string[];

  constructor(roots: string[]) {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const root of roots) {
      const real = canonicalExisting(root, "allowed root");
      const st = fs.statSync(real);
      if (!st.isDirectory()) throw new AppError("INVALID_INPUT", `allowed root is not a directory: ${root}`);
      const key = pathKey(real);
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(real);
      }
    }
    this.displayRoots = ordered;
    this.roots = [...ordered].sort((a, b) => b.length - a.length);
    if (this.roots.length === 0) throw new AppError("INVALID_INPUT", "at least one allowed root is required");
  }

  addRoot(root: string): void {
    const real = canonicalExisting(root, "browse root");
    if (!fs.statSync(real).isDirectory()) throw new AppError("INVALID_INPUT", "browse root is not a directory");
    const key = pathKey(real);
    if (!this.displayRoots.some((r) => pathKey(r) === key)) this.displayRoots.push(real);
    if (!this.roots.some((r) => pathKey(r) === key)) this.roots.push(real);
    this.roots.sort((a, b) => b.length - a.length);
  }

  /** Resolve an existing file/directory and enforce the allowlist. */
  resolve(p: string, label = "path"): string {
    if (typeof p !== "string" || p.length === 0) throw new AppError("INVALID_INPUT", `${label} is empty`);
    const real = canonicalExisting(p, label);
    for (const root of this.roots) {
      if (isWithin(root, real)) return real;
    }
    throw new AppError(
      "PERMISSION_DENIED",
      `${label} is outside the authorized roots (allowed: ${this.roots.join(", ")}); start the server with --workspace for the project directory`,
    );
  }

  /** Resolve a non-existing leaf under an allowed root (for output/config dirs). */
  resolveForCreate(p: string, label = "path"): string {
    const parent = canonicalExisting(path.dirname(p), `${label} parent`);
    const leaf = path.basename(p);
    if (!leaf || leaf === "." || leaf === ".." || leaf.includes(path.sep)) {
      throw new AppError("INVALID_INPUT", `${label} has an invalid leaf`);
    }
    const joined = path.join(parent, leaf);
    for (const root of this.roots) {
      if (isWithin(root, joined)) return joined;
    }
    throw new AppError("PERMISSION_DENIED", `${label} is outside the authorized roots`);
  }

  relativeDisplay(p: string): string {
    const real = canonicalExisting(p, "source path");
    for (const root of this.roots) {
      if (isWithin(root, real)) {
        const rel = path.relative(root, real).split(path.sep).join("/");
        return rel === "" ? path.basename(real) : rel;
      }
    }
    throw new AppError("PERMISSION_DENIED", "path is outside the authorized roots");
  }

  rootIdForPath(p: string): string {
    for (const root of this.roots) {
      if (isWithin(root, p)) return crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
    }
    throw new AppError("PERMISSION_DENIED", "path is outside the authorized roots");
  }

  redactText(text: string): string {
    let out = text;
    for (const root of this.roots) {
      out = out.split(root).join("<root>");
    }
    return out;
  }
}

export function safeChild(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const joined = path.resolve(base, ...parts);
  if (!isWithin(base, joined)) throw new AppError("INVALID_INPUT", "path escapes its directory");
  return joined;
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

export async function atomicWriteFile(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fh = await fsp.open(tmp, "w", mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
  await fsyncDir(dir);
}

export async function atomicWriteJson(file: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n", mode);
}

export async function fsyncDir(dir: string): Promise<void> {
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(dir, "r");
    await fh.sync();
  } catch {
    // Directory fsync is not available on every platform/filesystem. The
    // caller still gets file-level fsync and atomic rename.
  } finally {
    await fh?.close().catch(() => {});
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

export function parseJsonFile<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    throw new AppError("IO_ERROR", `cannot read JSON file ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
