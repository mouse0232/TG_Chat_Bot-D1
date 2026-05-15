/**
 * TMS 垃圾信息检测核心逻辑
 * 腾讯云文本内容安全服务 (TextModeration) 集成
 * 与 AI 反骚扰互斥，共享信任列表
 */

import { getBoolConfig, getConfig } from '../database/config.js';
import { getUserTrust, incrementCleanCount, recordSpam, checkAndPromoteToWhitelist } from '../database/trust.js';
import { updateUser } from '../database/users.js';
import { manageBlacklist } from '../services/blacklist.js';
import { api } from '../api/telegram.js';
import { callTmsApi } from './tencentTms.js';

const SPAM_INTERCEPT_MSG = "您的消息因包含垃圾信息已被过滤。如有疑问，请联系管理员。";

const TMS_LABEL_MAP = {
  Normal: "正常",
  Porn: "色情内容",
  Abuse: "辱骂内容",
  Ad: "广告内容",
  Illegal: "违法内容",
  Spam: "垃圾信息",
  Polity: "涉政内容",
  Terror: "暴恐内容",
  Custom: "自定义违规"
};

/**
 * TMS 垃圾信息检测
 * @param {Object} msg - Telegram Message 对象
 * @param {Object} user - DB 用户对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { spam, reason, label, score, skipped, error }
 */
export async function checkTmsSpam(msg, user, env) {
  const enabled = await getBoolConfig("enable_tencent_tms", env);
  if (!enabled) return { spam: false, skipped: true };

  const text = msg.text || msg.caption || "";
  if (!text) return { spam: false, skipped: true, reason: "非文本消息跳过TMS检测" };

  let trustInfo = await getUserTrust(user.user_id, env);
  if (!trustInfo) {
    await import('../database/trust.js').then(m => m.createUserTrust(user.user_id, msg.from?.username, env));
    trustInfo = await getUserTrust(user.user_id, env);
  }

  if (trustInfo?.trust_status === 'trusted') {
    return { spam: false, skipped: true, reason: "信任用户跳过检测" };
  }

  const truncatedText = text.substring(0, 10000);

  try {
    const tmsResult = await callTmsApi(env, truncatedText);
    const suggestion = tmsResult.Suggestion;
    const label = tmsResult.Label;
    const score = tmsResult.Score || 0;

    if (suggestion === "Block") {
      const reason = TMS_LABEL_MAP[label] || label || "TMS检测为违规内容";
      return { spam: true, reason, label, score, skipped: false };
    }

    if (suggestion === "Review") {
      const threshold = parseInt(await getConfig("tencent_tms_review_block_threshold", env)) || 60;
      if (score >= threshold) {
        const reason = TMS_LABEL_MAP[label] || label || "TMS疑似违规内容";
        return { spam: true, reason, label, score, skipped: false };
      }
    }

    return { spam: false, label, score, skipped: false };
  } catch (error) {
    console.error('[TmsAntiHarassment] TMS API call failed:', error);
    return { spam: false, skipped: false, error: true };
  }
}

/**
 * 处理 TMS 检测为垃圾的拦截动作
 * @param {string} userId - 用户 ID
 * @param {Object} userInfo - Telegram User 对象
 * @param {string} reason - 检测原因（中文）
 * @param {string} label - TMS Label
 * @param {number} score - TMS Score
 * @param {Object} env - 环境变量
 */
export async function handleTmsSpamIntercept(userId, userInfo, reason, label, score, env) {
  console.log(`[TmsAntiHarassment] User ${userId} TMS spam intercepted. Label: ${label}, Score: ${score}, Reason: ${reason}`);
  try {
    await recordSpam(userId, env);
    await updateUser(userId, { is_blocked: true, user_info: { tms_spam_reason: reason, tms_label: label, tms_score: score } }, env);
    const u = await import('../database/users.js').then(m => m.getUser(userId, env));
    await manageBlacklist(env, u, userInfo, true);

    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: SPAM_INTERCEPT_MSG
    }).catch(() => {});

    if (env.ADMIN_GROUP_ID) {
      const now = new Date();
      const utcPlus8Ms = now.getTime() + 8 * 60 * 60 * 1000;
      const d = new Date(utcPlus8Ms);
      const timeStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
      const senderName = `${userInfo?.first_name || ''}${userInfo?.last_name ? ' ' + userInfo.last_name : ''}`.trim() || 'Unknown';
      const uname = userInfo?.username ? ` (@${userInfo.username})` : '';
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        text: `\u{1F6D1} [TMS] \u5783\u573E\u4FE1\u606F\u8B66\u540A\n\n\u53D1\u9001\u8005: ${senderName}${uname} (ID: ${userId})\nTMS\u5224\u5B9A: ${label} (${reason})\n\u7F6E\u4FE1\u5EA6: ${score}\n\u5EFA\u8BAE: Block\n\u65F6\u95F4: ${timeStr}`,
        parse_mode: "HTML"
      }).catch(() => {});
    }
  } catch (error) {
    console.error(`[TmsAntiHarassment] TMS spam intercept failed for ${userId}:`, error);
  }
}

/**
 * 处理 TMS 检测为正常的通过动作（信任计数更新）
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} 是否被自动加信
 */
export async function handleTmsCleanPass(userId, env) {
  try {
    await incrementCleanCount(userId, env);
    const threshold = parseInt(await getConfig("tencent_tms_trust_threshold", env)) || 3;
    const promoted = await checkAndPromoteToWhitelist(userId, env, threshold);
    if (promoted) {
      console.log(`[TmsAntiHarassment] User ${userId} promoted to trust list`);
    }
    return promoted;
  } catch (error) {
    console.error(`[TmsAntiHarassment] Clean pass processing failed for ${userId}:`, error);
    return false;
  }
}