import crypto from 'node:crypto';
import { config } from '../config.ts';

/**
 * Message body signing.
 *
 * Originally `crypto.pbkdf2Sync(body, 'relay-signing', 200000, 32, 'sha256')` inline in
 * createMessage — 20.5ms of blocked event loop per message, and the wrong primitive: the "salt" was
 * a hard-coded constant and there was no secret, so anyone could recompute a valid signature for a
 * body they'd tampered with.
 *
 * A keyed HMAC is what "detect tampering" actually calls for. Its own module because it's a distinct
 * concern from writing a message, and because it's the piece most likely to be revisited (see the
 * note in docs/04-tradeoffs.md about not verifying on read yet).
 */

export function sign(body: string): string {
  return crypto.createHmac('sha256', config.messageSigningKey).update(body).digest('hex');
}

export function verifySignature(body: string, signature: string): boolean {
  const expected = sign(body);
  // Constant-time compare, or the check leaks the signature a byte at a time.
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
