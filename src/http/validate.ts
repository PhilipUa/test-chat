import { HttpError } from './errors.ts';

/** Small validation helpers — every id in this app arrives as an untrusted string. */

export function positiveInt(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw HttpError.badRequest(`${field} must be a positive integer`);
  }
  return n;
}

export function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return positiveInt(value, field);
}

export function boundedInt(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = positiveInt(value, field);
  return Math.min(n, max);
}

export function nonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw HttpError.badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw HttpError.badRequest(`${field} must not be empty`);
  if (trimmed.length > maxLength) {
    throw HttpError.badRequest(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function optionalClientId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw HttpError.badRequest('clientId must be a string');
  const trimmed = value.trim();
  // Column is VARCHAR(64); reject rather than silently truncating, which would make two
  // different sends collide on the idempotency index.
  if (trimmed.length > 64) throw HttpError.badRequest('clientId must be at most 64 characters');
  return trimmed || null;
}

export function intArray(value: unknown, field: string, maxLength = 100): number[] {
  if (!Array.isArray(value)) throw HttpError.badRequest(`${field} must be an array`);
  if (value.length === 0) throw HttpError.badRequest(`${field} must not be empty`);
  if (value.length > maxLength) {
    throw HttpError.badRequest(`${field} must contain at most ${maxLength} entries`);
  }
  // De-duplicate: the old code inserted participants in a loop and a repeated id tripped the
  // primary key, which is what took the process down.
  return [...new Set(value.map((v) => positiveInt(v, `${field}[]`)))];
}
