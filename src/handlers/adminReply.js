/**
 * 管理员回复处理器
 * 处理管理员在群组话题内的回复
 */

import { api } from '../api/telegram.js';
import { getConfig, setConfig } from '../database/config.js';
import { getUserByTopicId } from '../database/users.js';
import { isAuthAdmin } from '../utils/cache.js';
import { safeParse } from '../utils/helpers.js';
import { updateUser } from '../database/users.js';

/**
 * 处理管理员回复
 * @param {Object} msg - Telegram 消息对象
 * @param {Object} env - 环境变量
 */
export async function handleAdminReply(msg, env) {
  if (!msg.message_thread_id || msg.from.is_bot || !(await isAuthAdmin(msg.from.id, env))) return;

  const stateStr = await getConfig(`admin_state:${msg.from.id}`, env);
  if (stateStr) {
    const state = safeParse(stateStr);
    if (state.action === "input_note") {
      const { getUser } = await import('../database/users.js');
      const u = await getUser(state.target, env);
      u.user_info.note = msg.text === "/clear" || msg.text === "清除" ? "" : msg.text;
      await updateUser(state.target, { user_info: u.user_info }, env);
      await setConfig(`admin_state:${msg.from.id}`, "", env); // 清理状态
      
      // 更新资料卡
      if (u.topic_id && u.user_info.card_msg_id) {
        const { getUMeta } = await import('../utils/helpers.js');
        const meta = getUMeta(
          { id: state.target, first_name: u.user_info.name, username: u.user_info.username },
          u,
          u.user_info.join_date || Date.now() / 1000
        );
        const { getBtns } = await import('../utils/helpers.js');
        api(env.BOT_TOKEN, "editMessageText", {
          chat_id: env.ADMIN_GROUP_ID,
          message_id: u.user_info.card_msg_id,
          text: meta.card,
          parse_mode: "HTML",
          reply_markup: getBtns(state.target, u.is_blocked)
        }).catch(() => {});
      }
      return api(env.BOT_TOKEN, "sendMessage", { 
        chat_id: msg.chat.id, 
        message_thread_id: msg.message_thread_id, 
        text: "✅ 备注已更新" 
      });
    }
  }

  const uid = (await getUserByTopicId(msg.message_thread_id.toString(), env))?.user_id;
  if (!uid) return;

  try {
    await api(env.BOT_TOKEN, "copyMessage", { chat_id: uid, from_chat_id: msg.chat.id, message_id: msg.message_id });
  } catch {
    api(env.BOT_TOKEN, "sendMessage", { 
      chat_id: msg.chat.id, 
      message_thread_id: msg.message_thread_id, 
      text: "❌ 发送失败 (用户可能已停止Bot)" 
    }).catch(() => {});
  }
}
