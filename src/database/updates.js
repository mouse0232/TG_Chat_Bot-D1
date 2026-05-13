/**
 * Update 幂等性数据库操作
 */

import { tryRun, sql } from './index.js';

/**
 * 标记 Update 为已处理（幂等）
 * @param {Object} update - Telegram Update 对象
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} - 是否首次处理
 */
export async function markUpdateProcessed(update, env) {
  try {
    const uid = (update && (update.update_id ?? update.updateId))?.toString();
    if (!uid) return true;

    const now = Date.now();
    const res = await tryRun(env, "INSERT OR IGNORE INTO processed_updates (update_id, ts) VALUES (?,?)", [uid, now]);
    const changes = res?.meta?.changes ?? res?.changes ?? 0;
    return changes > 0;
  } catch {
    return true;
  }
}

/**
 * 清理过期 Update 记录
 * @param {number} cutoff - 截止时间戳
 * @param {Object} env - 环境变量
 */
export async function cleanupProcessedUpdates(cutoff, env) {
  try {
    await sql(env, "DELETE FROM processed_updates WHERE ts < ?", cutoff);
  } catch (e) {
    console.error("Cleanup Updates Failed:", e);
  }
}
