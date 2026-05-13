/**
 * 消息数据库操作
 */

import { sql } from './index.js';

/**
 * 保存消息记录
 * @param {string} userId - 用户 ID
 * @param {string} messageId - 消息 ID
 * @param {string} text - 消息文本
 * @param {number} date - 时间戳
 * @param {Object} env - 环境变量
 */
export async function saveMessage(userId, messageId, text, date, env) {
  try {
    await sql(env, "INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?,?,?,?)", [
      userId,
      messageId,
      text,
      date
    ]);
  } catch (e) {
    console.error("Save Message Failed:", e);
  }
}

/**
 * 清理过期消息
 * @param {number} cutoffSec - 截止时间戳
 * @param {Object} env - 环境变量
 */
export async function cleanupMessages(cutoffSec, env) {
  try {
    await sql(env, "DELETE FROM messages WHERE date < ?", cutoffSec);
  } catch (e) {
    console.error("Cleanup Messages Failed:", e);
  }
}
