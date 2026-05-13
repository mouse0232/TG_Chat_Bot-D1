/**
 * 用户资料卡服务
 */

import { api } from '../api/telegram.js';
import { updateUser } from '../database/users.js';
import { getUMeta, getBtns } from '../utils/helpers.js';

/**
 * 发送用户资料卡到话题
 * @param {Object} env - 环境变量
 * @param {Object} u - 用户对象
 * @param {Object} tgUser - Telegram 用户对象
 * @param {string} tid - 话题 ID
 * @param {number} date - 时间戳
 * @returns {Promise<number|null>} - 消息 ID
 */
export async function sendInfoCardToTopic(env, u, tgUser, tid, date) {
  const meta = getUMeta(tgUser, u, date || Date.now() / 1000);
  try {
    const card = await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: tid,
      text: meta.card,
      parse_mode: "HTML",
      reply_markup: getBtns(u.user_id, u.is_blocked)
    });
    await updateUser(u.user_id, { user_info: { card_msg_id: card.message_id } }, env);
    api(env.BOT_TOKEN, "pinChatMessage", { 
      chat_id: env.ADMIN_GROUP_ID, 
      message_id: card.message_id, 
      message_thread_id: tid 
    }).catch(() => {});
    return card.message_id;
  } catch {
    return null;
  }
}
