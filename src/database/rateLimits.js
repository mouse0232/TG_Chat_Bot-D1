/**
 * 限流数据库操作
 */

import { sql } from './index.js';
import { logError } from '../utils/logger.js';

export async function bumpRateLimit(env, key, now) {
  const q = `
    INSERT INTO ratelimits (key, ts, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET count = ratelimits.count + 1, ts = excluded.ts
    RETURNING count
  `;
  const row = await sql(env, q, [key, now], "first");
  return Number(row?.count || 0);
}

export async function cleanupRateLimits(cutoff, env) {
  try {
    await sql(env, "DELETE FROM ratelimits WHERE ts < ?", cutoff);
  } catch (e) {
    logError('DB', 'Cleanup rateLimits failed', e);
  }
}