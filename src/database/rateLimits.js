/**
 * 限流数据库操作
 */

import { sql } from './index.js';

/**
 * 增加限流计数
 * @param {Object} env - 环境变量
 * @param {string} key - 限流键
 * @param {number} now - 当前时间戳
 * @returns {Promise<number>} - 当前计数
 */
export async function bumpRateLimit(env, key, now) {
  const q = `
    INSERT INTO ratelimits (key, ts, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET count = ratelimits.count + 1, ts = excluded.ts
    RETURNING count
  `;
  const row = await sql(env, q, [key, now], "first");
  return Number(row?.count || 0);
}

/**
 * 清理过期限流记录
 * @param {number} cutoff - 截止时间戳
 * @param {Object} env - 环境变量
 */
export async function cleanupRateLimits(cutoff, env) {
  try {
    await sql(env, "DELETE FROM ratelimits WHERE ts < ?", cutoff);
  } catch (e) {
    console.error("Cleanup RateLimits Failed:", e);
  }
}
