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

import { AppError } from "../../contracts/src/errors.js";
import { QueryService } from "./queryService.js";
import { SnapshotStore } from "./snapshotStore.js";

export class QueryManager {
  readonly snapshots: SnapshotStore;
  private services = new Map<string, QueryService>();

  constructor(snapshots: SnapshotStore) {
    this.snapshots = snapshots;
  }

  get(projectId: string, snapshotId: string): QueryService {
    const dir = this.snapshots.snapshotPath(projectId, snapshotId);
    const key = dir;
    let svc = this.services.get(key);
    if (svc) return svc;
    svc = new QueryService(dir);
    this.services.set(key, svc);
    while (this.services.size > 6) {
      const first = this.services.keys().next().value as string | undefined;
      if (!first || first === key) break;
      const evicted = this.services.get(first);
      this.services.delete(first);
      if (evicted) void evicted.stop();
    }
    return svc;
  }

  async invalidate(projectId: string, snapshotId: string): Promise<void> {
    const dir = this.snapshots.projects.snapshotDir(projectId, snapshotId);
    const svc = this.services.get(dir);
    if (svc) {
      this.services.delete(dir);
      await svc.stop();
    }
  }

  async stopAll(): Promise<void> {
    const services = [...this.services.values()];
    this.services.clear();
    await Promise.all(services.map((svc) => svc.stop()));
  }

  call<T>(projectId: string, snapshotId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const svc = this.get(projectId, snapshotId);
    return svc.call<T>(method, params).catch((err) => {
      if (err instanceof AppError) throw err;
      throw new AppError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    });
  }
}
