/**
 * 消息编辑处理器
 */

import { api } from '../api/telegram.js';
import { getUser } from '../database/users.js';
import { escapeHTML } from '../utils/helpers.js';
import { log } from '../utils/logger.js';

/**
 * 处理用户编辑消息
 * @param {Object} msg - 编辑后的消息对象
 * @param {Object} env - 环境变量
 */
export async function handleEdit(msg, env) {
  const u = await getUser(msg.from.id.toString(), env);
  if (u.topic_id) {
    const txt = msg.text || msg.caption || "[非文本]";
    api(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: u.topic_id,
      text: `✏️ <b>用户修改了消息:</b>\n${escapeHTML(txt)}`,
      parse_mode: "HTML"
    }).catch(e => log.warn('Edit', 'send edit notification failed', { error: e?.message || String(e) }));
  }
}