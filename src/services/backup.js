/**
 * 备份服务
 */

import { api } from '../api/telegram.js';
import { getConfig } from '../database/config.js';
import { escapeHTML } from '../utils/helpers.js';

/**
 * 处理消息备份
 * @param {Object} msg - Telegram 消息对象
 * @param {Object} meta - 用户元信息
 * @param {Object} env - 环境变量
 */
export async function handleBackup(msg, meta, env) {
  const bid = await getConfig("backup_group_id", env);
  if (!bid) return;
  
  try {
    await api(env.BOT_TOKEN, "copyMessage", { 
      chat_id: bid, 
      from_chat_id: msg.chat.id, 
      message_id: msg.message_id 
    });
  } catch {
    if (msg.text) {
      api(env.BOT_TOKEN, "sendMessage", { 
        chat_id: bid, 
        text: `<b>备份</b> ${escapeHTML(meta.name)}:\n${escapeHTML(msg.text)}`, 
        parse_mode: "HTML" 
      }).catch(() => {});
    }
  }
}
