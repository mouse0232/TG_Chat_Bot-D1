/**
 * 用户资料卡服务
 */

import { api } from '../api/telegram.js';
import { updateUser } from '../database/users.js';
import { getUMeta, getBtns } from '../utils/helpers.js';
import { log } from '../utils/logger.js';

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
    }).catch(e => log.debug('InfoCard', 'Pin card message failed', { userId: u.user_id, msgId: card.message_id, error: e?.message || String(e) }));
    return card.message_id;
  } catch (e) {
    log.error('InfoCard', 'Send info card failed', { userId: u.user_id, error: e?.message || String(e) });
    return null;
  }
}