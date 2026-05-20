/**
 * 回调处理器
 * 处理内联键盘回调
 */

import { api } from '../api/telegram.js';
import { getConfig, setConfig } from '../database/config.js';
import { getUser, updateUser } from '../database/users.js';
import { resetUserTrust } from '../database/trust.js';
import { isAuthAdmin, isPrimaryAdmin } from '../utils/cache.js';
import { manageBlacklist } from '../services/blacklist.js';
import { handleAdminConfig } from './adminConfig.js';
import { log, logError } from '../utils/logger.js';

/**
 * 处理回调查询
 * @param {Object} cb - 回调查询对象
 * @param {Object} env - 环境变量
 */
export async function handleCallback(cb, env) {
  const { data, message: msg, from } = cb;
  const [act, p1, p2] = (data || "").split(":");

  if (act === "inbox" && p1 === "del") {
    await api(env.BOT_TOKEN, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(e => log.warn('Callback', 'delete message failed', { error: e?.message || String(e) }));
    if (p2) {
      const u = await getUser(p2, env);
      await updateUser(p2, { user_info: { ...u.user_info, last_notify: 0 } }, env);
    }
    return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "已处理" }).catch(e => log.debug('Callback', 'answer callback query failed', { error: e?.message || String(e) }));
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
    if (!(await isPrimaryAdmin(from.id, env))) {
      return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权", show_alert: true }).catch(e => log.debug('Callback', 'answer callback query failed', { error: e?.message || String(e) }));
    }
    await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id }).catch(e => log.debug('Callback', 'answer callback query failed', { error: e?.message || String(e) }));
    const [, t, k, v] = (data || "").split(":");
    return handleAdminConfig(msg.chat.id, msg.message_id, t, k, v, env);
  }

  if (msg.chat.id.toString() === env.ADMIN_GROUP_ID && ["block", "unblock"].includes(act)) {
    if (!(await isAuthAdmin(from.id, env))) {
      return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权", show_alert: true }).catch(e => log.debug('Callback', 'answer callback query failed', { error: e?.message || String(e) }));
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
      }).catch(e => log.warn('Callback', 'update card markup failed', { uid, error: e?.message || String(e) }));
    }
    await manageBlacklist(env, u, { id: uid, first_name: u.user_info.name || "User", username: u.user_info.username }, isB);
    api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: isB ? "已屏蔽" : "已解封" }).catch(e => log.debug('Callback', 'answer callback query failed', { error: e?.message || String(e) }));
  }

  if (act === "pin_card") {
    if (!(await isAuthAdmin(from.id, env))) {
      return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权", show_alert: true }).catch(e => log.debug('Callback', 'answer callback query failed', { error: e?.message || String(e) }));
    }
    api(env.BOT_TOKEN, "pinChatMessage", { 
      chat_id: msg.chat.id, 
      message_id: msg.message_id, 
      message_thread_id: msg.message_thread_id 
    }).catch(e => log.warn('Callback', 'pin message failed', { error: e?.message || String(e) }));
    api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "已置顶" }).catch(e => log.debug('Callback', 'answer callback query failed', { error: e?.message || String(e) }));
  }

  if (act === "ai_correction") {
    const userId = p1;
    const msgHash = p2;
    const correctResult = (data || "").split(":")[3];
    
    if (!(await isAuthAdmin(from.id, env))) {
      return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权", show_alert: true }).catch(e => log.debug('Callback', 'answer callback query failed', { error: e?.message || String(e) }));
    }

    await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

    try {
      const u = await getUser(userId, env);
      const originalMsg = u.user_info?.ai_spam_reason || "未知消息";
      const originalJudgment = "SPAM"; // Always intercepted as SPAM initially

      if (env.ENABLE_AI_MEMORY !== 'false') {
        try {
          const { addCorrection } = await import('../services/aiMemory.js');
          await addCorrection(userId, originalMsg, originalJudgment, correctResult, `管理员 ${from.id} 纠正`, env);
        } catch (e) {
          logError('AiCorrection', 'AiMemory failed', e);
        }
      }

      if (correctResult === 'CLEAN') {
        await updateUser(userId, { is_blocked: false }, env);
        await api(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: env.ADMIN_GROUP_ID,
          message_id: msg.message_id,
          reply_markup: { inline_keyboard: [[{ text: '✅ 已纠正: 误判放行 (CLEAN)', callback_data: 'none' }]] }
        }).catch(() => {});

        const learnHint = env.ENABLE_AI_MEMORY !== 'false'
          ? '\n\nAI 将学习此次纠正，避免同类误判。' 
          : '\n\n(长期记忆未开启，仅执行本地解封操作)';

        await api(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: `✅ 误判纠正已生效\n\n用户 ID: ${userId}\n结果: 解除黑名单，恢复正常聊天${learnHint}`
        }).catch(() => {});
      } else if (correctResult === 'SPAM') {
        await resetUserTrust(userId, env);
        await api(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: env.ADMIN_GROUP_ID,
          message_id: msg.message_id,
          reply_markup: { inline_keyboard: [[{ text: '❌ 已确认: 确认为 SPAM', callback_data: 'none' }]] }
        }).catch(() => {});

        const learnHint = env.ENABLE_AI_MEMORY !== 'false'
          ? '\n\nAI 将学习此次纠正，下次将正确拦截。' 
          : '\n\n(长期记忆未开启，仅执行信任度清零)';

        await api(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: `❌ 漏判纠正已生效\n\n用户 ID: ${userId}\n结果: 信任度清零，重新进入检测流程${learnHint}`
        }).catch(() => {});
      }
    } catch (error) {
      logError('AiCorrection', 'handleAiCorrection failed', error);
      await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "纠正失败", show_alert: true }).catch(() => {});
    }
  }
}