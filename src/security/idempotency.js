/**
 * Update 幂等去重
 */

import { markUpdateProcessed, cleanupProcessedUpdates } from '../database/updates.js';
import { PROCESSED_UPDATES_TTL_MS } from '../utils/constants.js';
import { safeWaitUntil } from '../utils/helpers.js';
import { shouldCleanup } from '../utils/cache.js';

/**
 * 标记 Update 为已处理（幂等）
 * @param {Object} update - Telegram Update 对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 * @returns {Promise<boolean>} - 是否首次处理
 */
export async function markUpdateOnce(update, env, ctx) {
  const ok = await markUpdateProcessed(update, env);
  if (!ok) return false;

  const now = Date.now();
  if ((now % 97) === 7) {
    if (shouldCleanup("processed_updates_ts", 60_000)) {
      safeWaitUntil(ctx, (async () => {
        const cutoff = now - PROCESSED_UPDATES_TTL_MS;
        await cleanupProcessedUpdates(cutoff, env);
      })());
    }
  }

  return true;
}
