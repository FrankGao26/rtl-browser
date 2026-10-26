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
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`rtl-browser: Node.js >= 24 is required (found ${process.version})`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const main = path.join(root, "dist", "server", "apps", "server", "src", "main.js");
if (!fs.existsSync(main)) {
  console.error("rtl-browser: server build is missing; run tools/build.sh or .\\tools\\build.ps1 first");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === "serve") args.shift();
const result = spawnSync(process.execPath, [main, ...args], { stdio: "inherit", windowsHide: false });
if (result.error) {
  console.error(`rtl-browser: failed to start server: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
