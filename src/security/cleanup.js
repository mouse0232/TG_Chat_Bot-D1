/**
 * TTL 清理调度
 */

import { MESSAGES_TTL_DAYS } from '../utils/constants.js';
import { shouldCleanup, safeWaitUntil } from '../utils/helpers.js';
import { cleanupMessages } from '../database/messages.js';

/**
 * 触发消息清理（概率触发）
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 */
export function maybeCleanupMessages(env, ctx) {
  const now = Date.now();
  if ((now % 131) !== 11) return;
  
  if (shouldCleanup("messages_ts", 10 * 60_000)) {
    safeWaitUntil(ctx, (async () => {
      const cutoffSec = Math.floor(now / 1000) - MESSAGES_TTL_DAYS * 86400;
      await cleanupMessages(cutoffSec, env);
    })());
  }
}
