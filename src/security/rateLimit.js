/**
 * 限流控制
 */

import { bumpRateLimit, cleanupRateLimits } from '../database/rateLimits.js';
import { 
  RATELIMIT_USER_WINDOW_MS, 
  RATELIMIT_USER_MAX, 
  RATELIMIT_GLOBAL_WINDOW_MS, 
  RATELIMIT_GLOBAL_MAX,
  RATELIMIT_CLEANUP_TTL_MS,
  SUBMIT_RL_WINDOW_MS,
  SUBMIT_RL_IP_MAX,
  SUBMIT_RL_UID_MAX
} from '../utils/constants.js';
import { safeWaitUntil } from '../utils/helpers.js';
import { shouldCleanup } from '../utils/cache.js';

/**
 * 检查私聊消息限流
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 * @returns {Promise<Object>}
 */
export async function checkRateLimit(userId, env, ctx) {
  const now = Date.now();
  const uid = userId?.toString() || "";
  if (!uid) return { allowed: true, retryAfterMs: 0 };

  const userBucket = Math.floor(now / RATELIMIT_USER_WINDOW_MS);
  const globalBucket = Math.floor(now / RATELIMIT_GLOBAL_WINDOW_MS);

  const userKey = `u:${uid}:${userBucket}`;
  const globalKey = `g:${globalBucket}`;

  const [uc, gc] = await Promise.all([
    bumpRateLimit(env, userKey, now), 
    bumpRateLimit(env, globalKey, now)
  ]);

  if ((now % 101) === 13) {
    if (shouldCleanup("ratelimits_ts", 60_000)) {
      safeWaitUntil(ctx, (async () => {
        const cutoff = now - RATELIMIT_CLEANUP_TTL_MS;
        await cleanupRateLimits(cutoff, env);
      })());
    }
  }

  if (gc > RATELIMIT_GLOBAL_MAX) return { allowed: false, retryAfterMs: RATELIMIT_GLOBAL_WINDOW_MS };
  if (uc > RATELIMIT_USER_MAX) return { allowed: false, retryAfterMs: RATELIMIT_USER_WINDOW_MS };

  return { allowed: true, retryAfterMs: 0 };
}

/**
 * 检查提交 Token 限流
 * @param {Request} req - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 * @param {string} uidMaybe - 用户 ID（可选）
 * @returns {Promise<Object>}
 */
export async function checkSubmitRateLimit(req, env, ctx, uidMaybe) {
  const now = Date.now();
  const ip = (req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() || "0.0.0.0";
  const bucket = Math.floor(now / SUBMIT_RL_WINDOW_MS);

  const ipKey = `s:ip:${ip}:${bucket}`;
  const ipCount = await bumpRateLimit(env, ipKey, now);
  if (ipCount > SUBMIT_RL_IP_MAX) return { allowed: false, reason: "ip" };

  if (uidMaybe) {
    const uKey = `s:u:${uidMaybe}:${bucket}`;
    const uCount = await bumpRateLimit(env, uKey, now);
    if (uCount > SUBMIT_RL_UID_MAX) return { allowed: false, reason: "uid" };
  }

  if ((now % 103) === 19) {
    if (shouldCleanup("ratelimits_ts", 60_000)) {
      safeWaitUntil(ctx, (async () => {
        const cutoff = now - RATELIMIT_CLEANUP_TTL_MS;
        await cleanupRateLimits(cutoff, env);
      })());
    }
  }

  return { allowed: true };
}
