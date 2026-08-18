import type { RequestHandler } from 'express';
import { config } from '../config.ts';
import { startRequestRateSampling } from '../util/process-metrics.ts';

/**
 * Counts requests, so the autoscaler can scale on request rate.
 *
 * `/api/health` is deliberately **not** counted. The autoscaler samples it ~24 times per tick to find
 * every replica, so counting it would mean the scaler's own polling showed up as load — it would scale up,
 * find more replicas to poll, read that as more load, and climb until it hit `max`. A metric that responds
 * to the act of measuring it is worse than no metric.
 *
 * Static files are counted: they are real work served by the replica.
 *
 * The window is short (see config.metrics.requestRateWindowSeconds) so the rate decays quickly once traffic
 * stops. With a full-minute window a finished burst keeps the scaler climbing for a minute afterwards —
 * observed, not theorised: a rate-driven run read *higher* after the load was dropped than during it.
 */
const sampler = startRequestRateSampling(config.metrics.requestRateWindowSeconds);

export const requestsPerMinute = (): number => Number(sampler.perMinute().toFixed(1));

export const countRequest: RequestHandler = (req, _res, next) => {
  if (req.path !== '/api/health') sampler.record();
  next();
};
