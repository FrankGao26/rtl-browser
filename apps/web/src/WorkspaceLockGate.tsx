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

import React, { useEffect, useRef, useState } from "react";

const LOCK_NAME = "rtl-browser-workspace";
const FALLBACK_KEY = "rtl-browser-workspace-owner";
const TAB_ID = crypto.randomUUID();

type LockManagerLike = {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: boolean },
    callback: (lock: unknown | null) => Promise<void>,
  ): Promise<void>;
  query(): Promise<{ held?: Array<{ name: string }> }>;
};

function lockManager(): LockManagerLike | null {
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/** Prevent two tabs on the same origin from driving one workspace at once. */
export function WorkspaceLockGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"acquiring" | "acquired" | "blocked">("acquiring");
  const stateRef = useRef(state);
  const attemptRef = useRef<() => void>(() => undefined);
  const releaseRef = useRef<(() => void) | null>(null);
  const [mode, setMode] = useState<"locks" | "local">("locks");

  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    let cancelled = false;
    const locks = lockManager();
    setMode(locks ? "locks" : "local");
    let timer = 0;

    const attemptLocks = () => {
      if (cancelled || !locks) return;
      void locks.request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (cancelled) return;
        if (!lock) {
          setState("blocked");
          return;
        }
        setState("acquired");
        await new Promise<void>((resolve) => { releaseRef.current = resolve; });
      });
    };

    if (locks) {
      attemptRef.current = attemptLocks;
      attemptLocks();
      timer = window.setInterval(() => {
        if (stateRef.current !== "blocked") return;
        void locks.query().then((result) => {
          if (!result.held?.some((lock) => lock.name === LOCK_NAME)) attemptLocks();
        }).catch(() => undefined);
      }, 1000);
    } else {
      const readOwner = (): { id?: string; expires?: number } | null => {
        try { return JSON.parse(localStorage.getItem(FALLBACK_KEY) ?? "null") as { id?: string; expires?: number } | null; }
        catch { return null; }
      };
      const owner = readOwner();
      if (owner && owner.id !== TAB_ID && typeof owner.expires === "number" && owner.expires > Date.now()) {
        setState("blocked");
      } else {
        localStorage.setItem(FALLBACK_KEY, JSON.stringify({ id: TAB_ID, expires: Date.now() + 4000 }));
        setState("acquired");
      }
      attemptRef.current = () => {
        const current = readOwner();
        if (current && current.id !== TAB_ID && typeof current.expires === "number" && current.expires > Date.now()) {
          setState("blocked");
          return;
        }
        localStorage.setItem(FALLBACK_KEY, JSON.stringify({ id: TAB_ID, expires: Date.now() + 4000 }));
        setState("acquired");
      };
      const onStorage = () => {
        const current = readOwner();
        if (current && current.id !== TAB_ID && typeof current.expires === "number" && current.expires > Date.now()) {
          if (stateRef.current === "acquired") setState("blocked");
        } else if (stateRef.current !== "acquired") {
          attemptRef.current();
        }
      };
      window.addEventListener("storage", onStorage);
      timer = window.setInterval(() => {
        const current = readOwner();
        if (current?.id === TAB_ID) {
          localStorage.setItem(FALLBACK_KEY, JSON.stringify({ id: TAB_ID, expires: Date.now() + 4000 }));
        } else if (stateRef.current === "blocked" && (!current || typeof current.expires !== "number" || current.expires <= Date.now())) {
          attemptRef.current();
        }
      }, 1500);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
        window.removeEventListener("storage", onStorage);
        if (readOwner()?.id === TAB_ID) localStorage.removeItem(FALLBACK_KEY);
      };
    }

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, []);

  if (state === "acquired") return <>{children}</>;
  return (
    <main className="workspace-lock-screen">
      <section className="workspace-lock-card">
        <h1>RTL Browser</h1>
        {state === "blocked" ? (
          <>
            <p>当前 workspace 已在同一个服务的另一个标签页中打开。</p>
            <p className="muted">
              同一服务只允许一个标签页使用 workspace。请关闭原标签页后再试；
              如果需要同时编译不同设计，请启动另一个 <span className="mono">rtl-browser serve</span> 进程。
            </p>
            <button className="primary" onClick={() => attemptRef.current()}>重试</button>
          </>
        ) : (
          <p className="muted">正在获取 workspace 访问权…</p>
        )}
        {mode === "local" && <p className="muted">当前浏览器不支持 Web Locks，已使用本地存储互斥。</p>}
      </section>
    </main>
  );
}
