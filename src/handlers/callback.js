/**
 * 回调处理器
 * 处理内联键盘回调
 */

import { api } from '../api/telegram.js';
import { getConfig, setConfig } from '../database/config.js';
import { getUser, updateUser } from '../database/users.js';
import { isAuthAdmin, isPrimaryAdmin } from '../utils/cache.js';
import { manageBlacklist } from '../services/blacklist.js';
import { handleAdminConfig } from './adminConfig.js';

/**
 * 处理回调查询
 * @param {Object} cb - 回调查询对象
 * @param {Object} env - 环境变量
 */
export async function handleCallback(cb, env) {
  const { data, message: msg, from } = cb;
  const [act, p1, p2] = (data || "").split(":");
  console.log("[CALLBACK] received:", data, "from:", from.id, "chat:", msg?.chat?.id);

  if (act === "inbox" && p1 === "del") {
    await api(env.BOT_TOKEN, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
    if (p2) {
      const u = await getUser(p2, env);
      await updateUser(p2, { user_info: { ...u.user_info, last_notify: 0 } }, env);
    }
    return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "已处理" }).catch(() => {});
  }

  if (act === "note" && p1 === "set") {
    await setConfig(`admin_state:${from.id}`, JSON.stringify({ action: "input_note", target: p2 }), env);
    return api(env.BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id,
      text: "⌨️ 请回复备注内容 (回复 /clear 清除):"
    });
  }

  if (act === "config") {
    const isAdmin = await isPrimaryAdmin(from.id, env);
    console.log("[CONFIG] user", from.id, "isAdmin:", isAdmin, "data:", data);
    if (!isAdmin) {
      return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权", show_alert: true }).catch(() => {});
    }
    await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
    const [, t, k, v] = (data || "").split(":");
    console.log("[CONFIG] parsed:", { type: t, key: k, val: v });
    return handleAdminConfig(msg.chat.id, msg.message_id, t, k, v, env);
  }

  if (msg.chat.id.toString() === env.ADMIN_GROUP_ID && ["block", "unblock"].includes(act)) {
    if (!(await isAuthAdmin(from.id, env))) {
      return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权", show_alert: true }).catch(() => {});
    }
    const isB = act === "block";
    const uid = p1;
    const u = await getUser(uid, env);
    await updateUser(uid, { is_blocked: isB, block_count: 0 }, env);

    if (u.user_info.card_msg_id) {
      const { getBtns } = await import('../utils/helpers.js');
      api(env.BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: env.ADMIN_GROUP_ID,
        message_id: u.user_info.card_msg_id,
        reply_markup: getBtns(uid, isB)
      }).catch(() => {});
    }
    await manageBlacklist(env, u, { id: uid, first_name: u.user_info.name || "User", username: u.user_info.username }, isB);
    api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: isB ? "已屏蔽" : "已解封" }).catch(() => {});
  }

  if (act === "pin_card") {
    if (!(await isAuthAdmin(from.id, env))) {
      return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权", show_alert: true }).catch(() => {});
    }
    api(env.BOT_TOKEN, "pinChatMessage", { 
      chat_id: msg.chat.id, 
      message_id: msg.message_id, 
      message_thread_id: msg.message_thread_id 
    }).catch(() => {});
    api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "已置顶" }).catch(() => {});
  }
}
