/**
 * Client-side validation. These throw Free2AIValidationError BEFORE any request
 * is sent — distinct from a server 400. Keeps obviously-invalid calls off the
 * wire while NEVER masking a server-side absence/transient as a client error.
 */
import { Free2AIValidationError } from "../errors.js";

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Free2AIValidationError(`"${field}" is required and must be a non-empty string`);
  }
  return value;
}

/** Clamp limit into [min,max] (mirrors the server clamp; never throws). */
export function clampLimit(
  limit: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit)) {
    throw new Free2AIValidationError(`"limit" must be a finite number`);
  }
  return Math.min(max, Math.max(min, Math.trunc(limit)));
}

export function requireIdCount(
  ids: unknown,
  field: string,
  min: number,
  max: number,
): string[] {
  if (!Array.isArray(ids)) {
    throw new Free2AIValidationError(`"${field}" must be an array of id strings`);
  }
  const clean = ids.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  if (clean.length < min || clean.length > max) {
    throw new Free2AIValidationError(
      `"${field}" must contain ${min}..${max} id strings (got ${clean.length})`,
    );
  }
  return clean;
}

export function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Free2AIValidationError(`"offset" must be a number >= 0`);
  }
  return Math.trunc(offset);
}

export function normalizePage(page: number | undefined): number {
  if (page === undefined) return 1;
  if (!Number.isFinite(page) || page < 1) {
    throw new Free2AIValidationError(`"page" must be a number >= 1`);
  }
  return Math.trunc(page);
}
