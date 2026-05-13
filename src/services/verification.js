/**
 * 验证服务
 * 管理用户验证流程
 */

import { api } from '../api/telegram.js';
import { updateUser } from '../database/users.js';
import { getConfig, getBoolConfig } from '../database/config.js';
import { genNonce, escapeHTML, safeParse } from '../utils/helpers.js';
import { VERIFY_NONCE_TTL_MS } from '../utils/constants.js';

/**
 * 发送验证流程
 * @param {string} id - 用户 ID
 * @param {Object} msg - Telegram 消息对象
 * @param {Object} env - 环境变量
 */
export async function sendVerification(id, msg, env) {
  const url = (env.WORKER_URL || "").replace(/\/$/, "");
  const vOn = await getBoolConfig("enable_verify", env);
  const qaOn = await getBoolConfig("enable_qa_verify", env);

  if (vOn && url) {
    const nonce = genNonce(24);
    const now = Date.now();
    await updateUser(
      id,
      {
        user_state: "pending_turnstile",
        user_info: { verify_nonce: nonce, verify_nonce_ts: now }
      },
      env
    );

    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: id,
      text: "🛡️ <b>安全验证</b>\n请点击下方按钮完成人机验证以继续。",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "点击进行验证",
              web_app: { url: `${url}/verify?user_id=${encodeURIComponent(id)}&nonce=${encodeURIComponent(nonce)}` }
            }
          ]
        ]
      }
    });
  } else if (qaOn) {
    await updateUser(id, { user_state: "pending_verification" }, env);
    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: id,
      text: "❓ <b>安全提问</b>\n" + (await getConfig("verif_q", env)),
      parse_mode: "HTML"
    });
  } else {
    await updateUser(id, { user_state: "verified" }, env);
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "✅ 已验证。\n请直接发送消息以联系管理员。" });
  }
}

/**
 * 验证问答答案
 * @param {string} id - 用户 ID
 * @param {string} ans - 用户答案
 * @param {Object} env - 环境变量
 */
export async function verifyAnswer(id, ans, env) {
  const correctAnswer = (await getConfig("verif_a", env)).trim();
  if (ans.trim() === correctAnswer) {
    await updateUser(id, { user_state: "verified" }, env);
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "✅ 验证通过！\n请直接发送消息以联系管理员。" });
  } else {
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 错误" });
  }
}

/**
 * 强制重置用户验证状态
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 */
export async function forceResetUserVerify(userId, env) {
  const uid = userId.toString();
  await updateUser(uid, {
    user_state: "new",
    user_info: { verify_nonce: "", verify_nonce_ts: 0 }
  }, env);
}
