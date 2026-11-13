import type { Context } from 'hono';
import { errorMessage, type ErrorCode, type ErrorParams } from './errors.ts';

export class HttpError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429;
  code: ErrorCode;
  params?: ErrorParams;
  constructor(status: HttpError['status'], code: ErrorCode, params?: ErrorParams) {
    super(errorMessage(code, params));
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/** JSON body of an API error: stable code, English message, optional parameters for localised text. */
export function errorBody(code: ErrorCode, params?: ErrorParams): { code: ErrorCode; error: string; params?: ErrorParams } {
  return params ? { code, error: errorMessage(code, params), params } : { code, error: errorMessage(code) };
}

// Reverse proxies such as Tailscale serve/funnel APPEND the real client IP to X-Forwarded-For: only the last entry is trusted.
export function clientIp(c: Context): string {
  const parts = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.at(-1) ?? 'unknown';
}
