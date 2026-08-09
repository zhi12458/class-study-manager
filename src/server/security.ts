import type { NextFunction, Request, Response } from "express";

interface LoginAttempt {
  count: number;
  resetAt: number;
}

export class LoginAttemptLimiter {
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly maxEntries = 10_000,
  ) {}

  retryAfterSeconds(key: string, now = Date.now()): number {
    const attempt = this.attempts.get(key);
    if (!attempt) return 0;
    if (attempt.resetAt <= now) {
      this.attempts.delete(key);
      return 0;
    }
    return attempt.count >= this.maxFailures ? Math.max(1, Math.ceil((attempt.resetAt - now) / 1000)) : 0;
  }

  recordFailure(key: string, now = Date.now()): void {
    this.prune(now);
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    current.count += 1;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private prune(now: number): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.resetAt <= now) this.attempts.delete(key);
    }
    while (this.attempts.size >= this.maxEntries) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.attempts.delete(oldest);
    }
  }
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join("; "));
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
}
