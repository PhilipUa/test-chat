import type { RequestHandler } from 'express';
import { config } from '../config.ts';

/**
 * Stamps every response with the replica that produced it.
 *
 * `/api/health` already reported its own `instanceId`, which answers "which process am I talking to?"
 * for exactly one endpoint — and never for the request you actually care about. Behind a round-robin
 * proxy the interesting failures are the intermittent ones, and "it only happens sometimes" is usually
 * "it only happens on one replica". You cannot chase that without being able to attribute a response.
 *
 * Mounted before everything, so it covers static files and error responses too. The failing requests
 * are the ones most worth attributing.
 */
export const instanceHeader: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Relay-Instance', config.instanceId);
  next();
};
