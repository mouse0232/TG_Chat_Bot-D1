/**
 * 未读通知服务
 * 聚合收件箱管理
 */

import { api } from '../api/telegram.js';
import { getConfig, setConfig } from '../database/config.js';
import { updateUser } from '../database/users.js';
import { escapeHTML, getUMeta } from '../utils/helpers.js';
import { hasLock, setLock } from '../utils/cache.js';
import { log } from '../utils/logger.js';

export async function handleInbox(env, msg, u, tid, uMeta) {
  const lk = `inbox:${u.user_id}`;
  if (hasLock(lk)) return;
  setLock(lk, 3000);

  let inboxId = await getConfig("unread_topic_id", env);
  if (!inboxId) {
    try {
      const t = await api(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: "🔔 未读消息" });
      inboxId = t.message_thread_id.toString();
      await setConfig("unread_topic_id", inboxId, env);
    } catch (e) {
      log.error('Inbox', 'Create unread topic failed', { error: e?.message || String(e) });
      return;
    }
  }

  const gid = env.ADMIN_GROUP_ID.toString().replace(/^-100/, "");
  const preview = msg.text ? (msg.text.length > 20 ? msg.text.substring(0, 20) + "..." : msg.text) : "[媒体消息]";
  const cardText = `<b>🔔 新消息</b>\n${uMeta.card}\n📝 <b>预览:</b> ${escapeHTML(preview)}`;
  const kb = {
    inline_keyboard: [[{ text: "🚀 直达回复", url: `https://t.me/c/${gid}/${tid}` }, { text: "✅ 已阅", callback_data: `inbox:del:${u.user_id}` }]]
  };

  try {
    if (u.user_info.inbox_msg_id) {
      try {
        await api(env.BOT_TOKEN, "editMessageText", {
          chat_id: env.ADMIN_GROUP_ID,
          message_id: u.user_info.inbox_msg_id,
          message_thread_id: inboxId,
          text: cardText,
          parse_mode: "HTML",
          reply_markup: kb
        });
        await updateUser(u.user_id, { user_info: { last_notify: Date.now() } }, env);
        return;
      } catch (e) {
        log.warn('Inbox', 'Edit inbox message failed', { userId: u.user_id, msgId: u.user_info.inbox_msg_id, error: e?.message || String(e) });
      }
    }

    const nm = await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: inboxId,
      text: cardText,
      parse_mode: "HTML",
      reply_markup: kb
    });
    await updateUser(u.user_id, { user_info: { last_notify: Date.now(), inbox_msg_id: nm.message_id } }, env);
  } catch (e) {
    if (e.message && e.message.includes("thread")) await setConfig("unread_topic_id", "", env);
  }
}