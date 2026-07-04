import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function getAuthToken(): string | undefined {
  const raw = process.env.BOOKKEEPING_AUTH_TOKEN;
  return raw && raw.length > 0 ? raw : undefined;
}

// Hash both sides to a fixed-length digest before comparing so
// timingSafeEqual never throws on a length mismatch and no length
// information about the real token leaks to a guesser.
function tokensMatch(expected: string, provided: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = getAuthToken();
  if (!token) {
    // No token configured: preserve today's trusted-localhost behavior.
    next();
    return;
  }

  const header = req.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !tokensMatch(token, provided)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
