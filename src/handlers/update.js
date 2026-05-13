/**
 * Update 主分发器
 * 将 Telegram Update 分发到对应处理器
 */

import { handlePrivate } from './private.js';
import { handleAdminReply } from './adminReply.js';
import { handleCallback } from './callback.js';
import { handleEdit } from './edit.js';

/**
 * 处理 Telegram Update
 * @param {Object} update - Telegram Update 对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 */
export async function handleUpdate(update, env, ctx) {
  const msg = update.message || update.edited_message;
  if (!msg) {
    if (update.callback_query) return handleCallback(update.callback_query, env);
    return null;
  }

  if (update.edited_message && msg.chat.type === "private") {
    return handleEdit(msg, env);
  }
  
  if (msg.chat.type === "private") {
    await handlePrivate(msg, env, ctx);
  } else if (msg.chat.id.toString() === env.ADMIN_GROUP_ID) {
    await handleAdminReply(msg, env);
  }
}
