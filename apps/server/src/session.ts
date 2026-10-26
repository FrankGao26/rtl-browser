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
import type { IncomingMessage } from "node:http";
import { AppError } from "../../../packages/contracts/src/errors.js";

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export class SessionManager {
  readonly bootstrapToken: string;
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly allowedHosts: Set<string>;
  readonly allowedOrigins: Set<string>;
  readonly cookieName: string;
  private bootstrapConsumed = false;

  constructor(port: number) {
    this.bootstrapToken = randomToken();
    this.sessionId = randomToken();
    this.csrfToken = randomToken();
    // Cookies are scoped by host, not by port. A per-port name prevents two
    // rtl-browser servers on 127.0.0.1 from overwriting each other's session.
    this.cookieName = `rtl_sid_${port}`;
    this.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    this.allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  }

  cookieHeader(): string {
    return `${this.cookieName}=${encodeURIComponent(this.sessionId)}; HttpOnly; SameSite=Strict; Path=/`;
  }

  isBootstrapToken(token: string | null): boolean {
    if (!token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.bootstrapToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  hasSession(req: IncomingMessage): boolean {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[this.cookieName] === this.sessionId;
  }

  requireSession(req: IncomingMessage): void {
    if (!this.hasSession(req)) throw new AppError("PERMISSION_DENIED", "open the launcher URL to start a session");
  }

  requireCsrf(req: IncomingMessage): void {
    this.requireSession(req);
    const got = req.headers["x-rtl-csrf"];
    if (typeof got !== "string" || got !== this.csrfToken) {
      throw new AppError("PERMISSION_DENIED", "invalid CSRF token");
    }
  }

  checkHost(req: IncomingMessage): void {
    const host = req.headers.host;
    if (!host || !this.allowedHosts.has(host)) throw new AppError("PERMISSION_DENIED", "invalid Host header");
  }

  checkOrigin(req: IncomingMessage, require: boolean): void {
    const origin = req.headers.origin;
    if (!origin) {
      if (require) throw new AppError("PERMISSION_DENIED", "missing Origin header");
      return;
    }
    if (!this.allowedOrigins.has(origin)) throw new AppError("PERMISSION_DENIED", "invalid Origin header");
  }

  bootstrapRedirectUrl(rawUrl: string): string | null {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (!this.isBootstrapToken(url.searchParams.get("token"))) return null;
    if (this.bootstrapConsumed) return null;
    this.bootstrapConsumed = true;
    url.searchParams.delete("token");
    return `${url.pathname}${url.search}${url.hash}`;
  }
}
