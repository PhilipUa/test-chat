import { HttpError } from './errors.ts';

/** Small validation helpers — every id in this app arrives as an untrusted string. */

interface IntOptions {
  /** Smallest accepted value. Defaults to 1, since most numbers here are ids. */
  min?: number;
  /** Values above this are clamped, not rejected — a caller asking for too much gets the cap. */
  max?: number;
}

/**
 * The one integer parser.
 *
 * There were five of these — positiveInt, optionalPositiveInt, optionalNonNegativeInt, boundedInt,
 * boundedNonNegativeInt — differing only in optionality, a minimum and a cap. Each decided its own
 * zero-handling, and two decided wrongly: `?offset=0` and `?since=0` both returned 400, even though
 * zero is exactly what a first page and a from-the-beginning cursor ask for.
 *
 * That's the argument for collapsing them. Not less code — one place to be correct.
 */
function parseInt_(value: unknown, field: string, { min = 1, max }: IntOptions = {}): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n < min) {
    throw HttpError.badRequest(
      min === 1
        ? `${field} must be a positive integer`
        : `${field} must be an integer of at least ${min}`,
    );
  }
  return max === undefined ? n : Math.min(n, max);
}

const absent = (value: unknown): boolean =>
  value === undefined || value === null || value === '';

/** Required integer. `min` defaults to 1; pass 0 where zero is meaningful. */
export function int(value: unknown, field: string, opts?: IntOptions): number {
  return parseInt_(value, field, opts);
}

/** Optional integer — undefined when absent. */
export function optionalInt(
  value: unknown,
  field: string,
  opts?: IntOptions,
): number | undefined {
  return absent(value) ? undefined : parseInt_(value, field, opts);
}

/** Optional integer with a default, clamped to `max`. For page sizes and offsets. */
export function intOr(
  value: unknown,
  field: string,
  fallback: number,
  opts?: IntOptions,
): number {
  return absent(value) ? fallback : parseInt_(value, field, opts);
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
  if (absent(value)) return null;
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
  return [...new Set(value.map((v) => parseInt_(v, `${field}[]`)))];
}

export function optionalIsoDate(value: unknown, field: string): Date | undefined {
  if (absent(value)) return undefined;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw HttpError.badRequest(`${field} must be an ISO date`);
  }
  return parsed;
}
