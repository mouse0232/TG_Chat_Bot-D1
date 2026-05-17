/**
 * 黑名单服务
 */

import { api } from '../api/telegram.js';
import { getConfig, setConfig } from '../database/config.js';
import { updateUser } from '../database/users.js';
import { escapeHTML, getUMeta } from '../utils/helpers.js';
import { log } from '../utils/logger.js';

export async function manageBlacklist(env, u, tgUser, isBlocking) {
  let bid = await getConfig("blocked_topic_id", env);
  if (!bid && isBlocking) {
    try {
      const t = await api(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: "🚫 黑名单" });
      bid = t.message_thread_id.toString();
      await setConfig("blocked_topic_id", bid, env);
    } catch (e) {
      log.error('Blacklist', 'Create blocked topic failed', { error: e?.message || String(e) });
      return;
    }
  }
  if (!bid) return;

  if (isBlocking) {
    const meta = getUMeta(tgUser, u, Date.now() / 1000);
    const m = await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: bid,
      text: `<b>🚫 用户已屏蔽</b>\n${meta.card}`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "✅ 解除屏蔽", callback_data: `unblock:${u.user_id}` }]] }
    }).catch(e => log.warn('Blacklist', 'Send block notification failed', { userId: u.user_id, error: e?.message || String(e) }));
    if (m) await updateUser(u.user_id, { user_info: { blacklist_msg_id: m.message_id } }, env);
  } else {
    if (u.user_info.blacklist_msg_id) {
      api(env.BOT_TOKEN, "deleteMessage", { chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.blacklist_msg_id }).catch(e => log.debug('Blacklist', 'Delete blacklist message failed', { userId: u.user_id, msgId: u.user_info.blacklist_msg_id, error: e?.message || String(e) }));
      await updateUser(u.user_id, { user_info: { blacklist_msg_id: null } }, env);
    }
  }
}