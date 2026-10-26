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

// Developer environment check shared by Linux and Windows.
import { spawnSync } from "node:child_process";
import process from "node:process";

const failures = [];
function version(command, args = ["--version"]) {
  const r = spawnSync(command, args, { encoding: "utf8" });
  if (r.error) return null;
  const text = `${r.stdout}${r.stderr}`.trim();
  return text ? text.split(/\r?\n/)[0] : null;
}
function requireCommand(name, args) {
  const v = version(name, args);
  if (!v) failures.push(`${name} not found`);
  else console.log(`${name}: ${v}`);
  return v;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) failures.push(`Node.js >= 24 required (found ${process.versions.node})`);
console.log(`node: ${process.version}`);

const cmake = requireCommand("cmake", ["--version"]);
if (cmake) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(cmake);
  if (!m || Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 28)) {
    failures.push(`CMake >= 3.28 required (found ${cmake})`);
  }
}
requireCommand("ninja", ["--version"]);
requireCommand("git", ["--version"]);
const python = requireCommand("python3", ["--version"]) ?? requireCommand("python", ["--version"]) ?? requireCommand("py", ["-3", "--version"]);
if (!python) failures.push("Python 3 not found");

const compiler = process.platform === "win32"
  ? (version("cl", []) ?? version("clang-cl", ["--version"]))
  : (version("g++", ["--version"]) ?? version("clang++", ["--version"]));
if (!compiler) failures.push(process.platform === "win32"
  ? "MSVC cl.exe or clang-cl not found (run from a Visual Studio developer prompt)"
  : "g++ or clang++ not found");
else console.log(`compiler: ${compiler}`);

if (process.platform === "win32") {
  if (!version("npm.cmd", ["--version"])) failures.push("npm.cmd not found");
} else if (!version("npm", ["--version"])) {
  failures.push("npm not found");
}

if (failures.length) {
  console.error("\nMissing requirements:");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("environment: PASS");
