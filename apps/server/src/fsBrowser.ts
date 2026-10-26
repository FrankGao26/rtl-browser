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
import { AppError } from "../../../packages/contracts/src/errors.js";
import type { FsEntry, FsListing } from "../../../packages/contracts/src/types.js";
import { AllowedRoots, isWithin, normalizeNativePath } from "../../../packages/core/src/paths.js";

export class FsBrowser {
  readonly roots: AllowedRoots;

  constructor(roots: AllowedRoots) {
    this.roots = roots;
  }

  list(rawPath: string | null): FsListing {
    if (!rawPath) {
      const entries: FsEntry[] = this.roots.displayRoots.map((root) => ({
        name: path.basename(root) || root,
        path: root,
        kind: "directory" as const,
        size: null,
        readable: true,
      }));
      return { rootId: "roots", path: "", parentPath: null, entries, truncated: false };
    }
    const real = this.roots.resolve(rawPath, "path");
    const stateName = (name: string) => process.platform === "win32" ? name.toLowerCase() === ".rtlb" : name === ".rtlb";
    if (real.split(path.sep).some(stateName)) throw new AppError("INVALID_INPUT", "the project state directory is hidden");
    const st = fs.statSync(real);
    if (!st.isDirectory()) throw new AppError("INVALID_INPUT", "path is not a directory");
    const names = fs.readdirSync(real, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const d of names) {
      if (entries.length >= 1000) break;
      if (stateName(d.name)) continue;
      const p = path.join(real, d.name);
      try {
        // Resolve every entry, not only lstat-reported symlinks: Windows
        // junctions and other reparse points are reported as directories.
        const realEntry = normalizeNativePath(fs.realpathSync.native(p));
        if (!this.roots.displayRoots.some((r) => isWithin(r, realEntry))) continue;
        const st2 = fs.statSync(realEntry);
        entries.push({
          name: d.name,
          path: p,
          kind: st2.isDirectory() ? "directory" : "file",
          size: st2.isFile() ? st2.size : null,
          readable: true,
        });
      } catch {
        // Broken links and permission failures are omitted rather than
        // turning the listing into an error.
      }
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    const parent = path.dirname(real);
    const parentPath = parent !== real && this.roots.displayRoots.some((r) => isWithin(r, parent)) ? parent : null;
    return {
      rootId: this.roots.rootIdForPath(real),
      path: real,
      parentPath,
      entries,
      truncated: names.length > entries.length,
    };
  }
}
