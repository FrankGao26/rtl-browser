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
import { AppError } from "../../contracts/src/errors.js";
import { validateBuildConfig } from "../../contracts/src/validation.js";
import {
  PROTOCOL_VERSION,
  type BuildConfig,
  type Define,
  type ParameterOverride,
} from "../../contracts/src/types.js";
import { canonicalExisting, isWithin, sha256Text, stableJson } from "./paths.js";

export interface BuildConfigDraft {
  name?: string;
  projectRoot?: string;
  inputMode: "filelist" | "sources";
  filelistPath?: string;
  filelistMode?: "-f" | "-F";
  sourcePaths?: string[];
  workingDirectory?: string;
  topMode: "explicit" | "automatic";
  topModule: string;
  sourceRoots?: string[];
  defines: Define[];
  includeRoots: string[];
  libraries: string[];
  parameters: ParameterOverride[];
  language: string | null;
  singleUnit: boolean;
  threads: number;
  warningAsError: boolean;
  warningOptions?: string[];
}

export const STATE_DIR_NAME = ".rtlb";

function str(v: unknown, label: string, max = 1_000_000): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw new AppError("INVALID_INPUT", `${label} must be a non-empty string`);
  }
  return v;
}
function optStr(v: unknown, label: string): string | null {
  if (v === undefined || v === null) return null;
  return str(v, label);
}
function bool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") throw new AppError("INVALID_INPUT", `${label} must be boolean`);
  return v;
}
function int(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new AppError("INVALID_INPUT", `${label} must be an integer in [${min}, ${max}]`);
  }
  return v;
}
function arr(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) throw new AppError("INVALID_INPUT", `${label} must be an array`);
  return v;
}
function strArr(v: unknown, label: string, max = 100_000): string[] {
  return arr(v, label).map((x, i) => str(x, `${label}[${i}]`, 1_000_000));
}

/** Expand $VAR, ${VAR}, %VAR% and a leading ~ in a user-supplied path. */
export function expandPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = input;
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    const home = env.HOME ?? env.USERPROFILE;
    if (!home) throw new AppError("INVALID_INPUT", "HOME/USERPROFILE is not set");
    out = path.join(home, out.slice(2));
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => {
    const value = env[name];
    if (value === undefined) throw new AppError("INVALID_INPUT", `environment variable is not set: ${name}`);
    return value;
  });
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const value = env[name];
    if (value === undefined) throw new AppError("INVALID_INPUT", `environment variable is not set: ${name}`);
    return value;
  });
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const value = env[name];
    if (value === undefined) throw new AppError("INVALID_INPUT", `environment variable is not set: ${name}`);
    return value;
  });
  return out;
}

function readable(real: string, label: string): void {
  try {
    fs.accessSync(real, fs.constants.R_OK);
  } catch {
    throw new AppError("PERMISSION_DENIED", `${label} is not readable`);
  }
}

function resolveProjectPath(projectRoot: string, raw: string, label: string, kind: "file" | "directory"): string {
  const expanded = expandPath(raw);
  const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
  let real: string;
  try {
    real = canonicalExisting(candidate, label);
  } catch (err) {
    if (err instanceof AppError && /accessible/.test(err.message)) {
      throw new AppError("INVALID_INPUT", `${label} does not exist or is not accessible`);
    }
    throw err;
  }
  const stateDir = path.join(projectRoot, STATE_DIR_NAME);
  if (isWithin(stateDir, real)) throw new AppError("INVALID_INPUT", `${label} must not point inside ${STATE_DIR_NAME}`);
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
    readable(real, label);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("PERMISSION_DENIED", `${label} is not accessible`);
  }
  if (kind === "file" && !st.isFile()) throw new AppError("INVALID_INPUT", `${label} is not a file`);
  if (kind === "directory" && !st.isDirectory()) throw new AppError("INVALID_INPUT", `${label} is not a directory`);
  return real;
}

export function projectInputDigest(config: BuildConfig): string {
  const copy: Record<string, unknown> = { ...config };
  delete copy.projectId;
  delete copy.name;
  delete copy.configRevision;
  delete copy.configDigest;
  delete copy.threads;
  delete copy.warningAsError;
  delete copy.warningOptions;
  return sha256Text(stableJson(copy));
}

/** Compute the canonical digest for a config whose identity fields are already final. */
export function buildConfigDigest(config: Omit<BuildConfig, "configDigest">): string {
  const copy: Record<string, unknown> = { ...config };
  delete copy.configRevision;
  delete copy.projectId;
  delete copy.name;
  return sha256Text(stableJson(copy));
}

function digestInput(config: Omit<BuildConfig, "configDigest">): string {
  return buildConfigDigest(config);
}

export function normalizeDraft(raw: unknown, projectId: string, revision: number, activeRoot?: string): BuildConfig {
  if (typeof raw !== "object" || raw === null) throw new AppError("INVALID_INPUT", "config must be an object");
  const o = raw as Record<string, unknown>;
  const inputMode = o.inputMode;
  if (inputMode !== "filelist" && inputMode !== "sources") {
    throw new AppError("INVALID_INPUT", "inputMode must be filelist or sources");
  }
  if (o.topMode !== "explicit") {
    throw new AppError("INVALID_INPUT", "this vertical slice supports explicit Top only");
  }
  const projectRoot = activeRoot ? path.resolve(activeRoot) : str(o.projectRoot, "projectRoot");
  const defines = arr(o.defines ?? [], "defines").map((d, i) => {
    if (typeof d !== "object" || d === null) throw new AppError("INVALID_INPUT", `defines[${i}] invalid`);
    const x = d as Record<string, unknown>;
    return { name: str(x.name, `defines[${i}].name`, 256), value: optStr(x.value, `defines[${i}].value`) } satisfies Define;
  });
  const parameters = arr(o.parameters ?? [], "parameters").map((p, i) => {
    if (typeof p !== "object" || p === null) throw new AppError("INVALID_INPUT", `parameters[${i}] invalid`);
    const x = p as Record<string, unknown>;
    return { name: str(x.name, `parameters[${i}].name`, 256), value: str(x.value, `parameters[${i}].value`, 4096) } satisfies ParameterOverride;
  });
  const base: Omit<BuildConfig, "configDigest"> = {
    protocolVersion: PROTOCOL_VERSION,
    projectId,
    name: path.basename(projectRoot),
    projectRoot,
    inputMode,
    ...(inputMode === "filelist" ? {
      filelistPath: str(o.filelistPath, "filelistPath"),
      filelistMode: (o.filelistMode === "-F" ? "-F" : "-f") as "-f" | "-F",
    } : {}),
    ...(inputMode === "sources" ? { sourcePaths: strArr(o.sourcePaths ?? [], "sourcePaths") } : {}),
    workingDirectory: projectRoot,
    topMode: "explicit",
    topModule: str(o.topModule, "topModule", 1024),
    sourceRoots: [projectRoot],
    defines,
    includeRoots: strArr(o.includeRoots ?? [], "includeRoots", 10_000),
    libraries: strArr(o.libraries ?? [], "libraries", 10_000),
    parameters,
    language: optStr(o.language, "language"),
    singleUnit: bool(o.singleUnit ?? false, "singleUnit"),
    threads: int(o.threads ?? 1, "threads", 1, 64),
    warningAsError: bool(o.warningAsError ?? false, "warningAsError"),
    warningOptions: strArr(o.warningOptions ?? [], "warningOptions", 256),
    configRevision: revision,
  };
  return validateBuildConfig({ ...base, configDigest: digestInput(base) });
}

export interface ValidatedPaths {
  projectRoot: string;
  workingDirectory: string;
  filelistPath: string | null;
  sourcePaths: string[];
  sourceRoots: string[];
  includeRoots: string[];
  libraries: string[];
}

export function validateConfigPaths(config: BuildConfig, projectRoot: string): ValidatedPaths {
  const root = canonicalExisting(projectRoot, "projectRoot");
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
    fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new AppError("PERMISSION_DENIED", "projectRoot is not readable");
  }
  if (!st.isDirectory()) throw new AppError("INVALID_INPUT", "projectRoot is not a directory");
  let filelistPath: string | null = null;
  if (config.inputMode === "filelist") {
    filelistPath = resolveProjectPath(root, config.filelistPath!, "filelistPath", "file");
  }
  const sourcePaths = (config.sourcePaths ?? []).map((p) => resolveProjectPath(root, p, "sourcePath", "file"));
  const includeRoots = config.includeRoots.map((p) => resolveProjectPath(root, p, "includeRoot", "directory"));
  const libraries = config.libraries.map((p) => resolveProjectPath(root, p, "library", "file"));
  return { projectRoot: root, workingDirectory: root, filelistPath, sourcePaths, sourceRoots: [root], includeRoots, libraries };
}

export function configToDisk(config: BuildConfig, paths: ValidatedPaths): BuildConfig {
  const base: Omit<BuildConfig, "configDigest"> = {
    ...config,
    name: path.basename(paths.projectRoot),
    projectRoot: paths.projectRoot,
    workingDirectory: paths.workingDirectory,
    ...(paths.filelistPath ? { filelistPath: paths.filelistPath } : {}),
    sourcePaths: paths.sourcePaths,
    sourceRoots: paths.sourceRoots,
    includeRoots: paths.includeRoots,
    libraries: paths.libraries,
  };
  return validateBuildConfig({ ...base, configDigest: digestInput(base) });
}

export function validateConfigForBuild(config: BuildConfig, projectRoot: string): BuildConfig {
  const paths = validateConfigPaths(config, projectRoot);
  if (!config.topModule.trim()) throw new AppError("INVALID_INPUT", "Top module is required");
  if (config.inputMode === "sources" && (config.sourcePaths?.length ?? 0) === 0) {
    throw new AppError("INVALID_INPUT", "sourcePaths must not be empty");
  }
  return configToDisk(config, paths);
}

export function configSummary(config: BuildConfig): Record<string, unknown> {
  return {
    inputMode: config.inputMode,
    filelistPath: config.filelistPath ?? null,
    sourcePaths: config.sourcePaths ?? [],
    topModule: config.topModule,
    includeRoots: config.includeRoots,
    libraries: config.libraries,
    parameters: config.parameters,
    language: config.language,
    singleUnit: config.singleUnit,
    threads: config.threads,
    warningAsError: config.warningAsError,
    warningOptions: config.warningOptions,
    configRevision: config.configRevision,
    configDigest: config.configDigest,
  };
}
