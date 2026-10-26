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

export const ERROR_CODES = [
  "UNSUPPORTED_VERSION",
  "INVALID_INPUT",
  "SNAPSHOT_INCOMPLETE",
  "SNAPSHOT_MISMATCH",
  "SOURCE_MISMATCH",
  "CAPABILITY_MISSING",
  "QUERY_LIMIT",
  "QUERY_TIMEOUT",
  "RESOURCE_LIMIT",
  "CANCELLED",
  "COMPILER_ERROR",
  "IO_ERROR",
  "PERMISSION_DENIED",
  "STALE_CURSOR",
  "SNAPSHOT_CORRUPT",
  "SNAPSHOT_VERSION_MISMATCH",
  "SOURCE_UNAVAILABLE",
  "TASK_CONFLICT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function asAppError(err: unknown, fallbackCode: ErrorCode = "INTERNAL_ERROR"): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) return new AppError(fallbackCode, err.message);
  return new AppError(fallbackCode, String(err));
}

export function errorResponse(err: unknown): {
  ok: false;
  error: { code: string; message: string; retryable: boolean; details?: unknown };
} {
  const e = asAppError(err);
  return {
    ok: false,
    error: {
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      ...(e.details === undefined ? {} : { details: e.details }),
    },
  };
}
