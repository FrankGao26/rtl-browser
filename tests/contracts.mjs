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
import {
  assertDisplayPath,
  validateBuildConfig,
  validateManifest,
  validateWorkerMessage,
} from "../dist/server/packages/contracts/src/validation.js";
import { PROTOCOL_VERSION, REQUIRED_CAPABILITIES } from "../dist/server/packages/contracts/src/types.js";

const ROOT = process.env.RTL_PROJECT_ROOT ? path.resolve(process.env.RTL_PROJECT_ROOT) : path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "contracts", "fixtures");

const config = validateBuildConfig(JSON.parse(fs.readFileSync(path.join(FIXTURES, "build-config.simple.json"), "utf8")));
assert.equal(config.protocolVersion, PROTOCOL_VERSION);
assert.deepEqual(config.warningOptions, []);

const lines = fs.readFileSync(path.join(FIXTURES, "worker-messages.ndjson"), "utf8").split(/\r?\n/).filter(Boolean);
assert.ok(lines.length >= 5);
for (const line of lines) validateWorkerMessage(JSON.parse(line));

const values = JSON.parse(fs.readFileSync(path.join(FIXTURES, "values.json"), "utf8"));
assert.equal(values.aboveJsSafeInteger, "9007199254740993");
assert.equal(typeof values.aboveJsSafeInteger, "string");
assert.equal(values.zero, 0);
assert.equal(values.emptyString, "");
assert.equal(values.fourState, "4'b10xz");

const manifest = {
  schemaVersion: 1,
  protocolVersion: PROTOCOL_VERSION,
  extractorVersion: "0.9.11",
  compilerVersion: "12.0.0+545f88b2e",
  compilerCommit: "545f88b2ed3a2d20325fbd17413af177a6bca72f",
  snapshotId: "s_0000000000000000",
  projectId: "fixture-project",
  jobId: "job-fixture",
  createdAt: "2026-01-01T00:00:00Z",
  configDigest: "0".repeat(64),
  rootInstanceId: "1",
  rootPath: "top",
  topModule: "top",
  capabilities: [...REQUIRED_CAPABILITIES],
  capabilityComplete: {},
  counts: { instances: 1, symbols: 1, occurrences: 1, drivers: 1, loads: 1, sources: 1 },
  sources: [{ sourceId: "1", displayPath: "top.sv", sha256: "0".repeat(64), bytes: 1 }],
  indexSha256: "0".repeat(64),
  status: "COMPLETE",
};
validateManifest(manifest);

assert.throws(() => validateBuildConfig({ ...config, protocolVersion: 999 }), /protocolVersion/);
assert.throws(() => validateWorkerMessage({ protocolVersion: 999, jobId: "x", seq: 0, type: "hello" }), /protocol/);
assert.throws(() => assertDisplayPath("/etc/passwd"));
assert.throws(() => assertDisplayPath("../secret.sv"));
assert.throws(() => assertDisplayPath("C:/project/leaf.sv"));
assert.throws(() => assertDisplayPath("//server/share/leaf.sv"));
assert.throws(() => assertDisplayPath("rtl\\leaf.sv"));
assertDisplayPath("rtl/leaf.sv");

console.log("contracts: PASS");
