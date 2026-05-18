/**
 * 私聊消息处理器
 * 处理用户私聊消息、验证流程和管理员命令
 */

import { api } from '../api/telegram.js';
import { registerCommands } from '../api/commands.js';
import { getUser, updateUser } from '../database/users.js';
import { getConfig, getBoolConfig, getJsonConfig } from '../database/config.js';
import { isAuthAdmin, isPrimaryAdmin } from '../utils/cache.js';
import { checkRateLimit } from '../security/rateLimit.js';
import { relayToTopic } from '../services/relay.js';
import { sendVerification, verifyAnswer, forceResetUserVerify } from '../services/verification.js';
import { handleAdminConfig, handleAdminInput } from './adminConfig.js';
import { MSG_TYPES } from '../utils/constants.js';
import { escapeHTML, safeParse } from '../utils/helpers.js';
import { hasLock, setLock } from '../utils/cache.js';
import { safeRegexTest } from '../security/regexGuard.js';
import { checkUser, handleUserIntercept, checkMessage, handleMessageIntercept } from '../security/antiHarassment.js';
import { checkAiSpam, handleAiSpamIntercept, handleAiCleanPass } from '../security/aiAntiHarassment.js';
import { checkGreenSpam, handleGreenSpamIntercept, handleGreenCleanPass } from '../security/greenAntiHarassment.js';
import { checkAllPermissions, formatPermissionReport } from '../services/permissionCheck.js';
import { log } from '../utils/logger.js';

/**
 * 处理私聊消息
 * @param {Object} msg - Telegram 消息对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 */
export async function handlePrivate(msg, env, ctx) {
  const id = msg.chat.id.toString();
  const text = msg.text || "";
  const isStart = text.startsWith("/start");

  // 先取用户，保证 block 生效是 DB 真实状态
  const u0 = await getUser(id, env);

  // 反骚扰用户检测（非管理员）
  if (!(await isAuthAdmin(id, env))) {
    const userCheck = await checkUser(msg.from, env);
    if (userCheck.triggered) {
      await handleUserIntercept(id, userCheck.reason, env);
      return;
    }
  }
  
  // 屏蔽用户处理
  if (u0.is_blocked && !(await isAuthAdmin(id, env))) {
    const bk = `blocked_notice:${id}`;
    if (!hasLock(bk)) {
      setLock(bk, 10000);
      api(env.BOT_TOKEN, "sendMessage", {
        chat_id: id,
        text: "🚫 您已被管理员屏蔽，无法发送消息。如有误判请联系管理员解除。"
      }).catch(e => log.warn('Private', 'send blocked notice failed', { chatId: id, error: e?.message || String(e) }));
    }
    return;
  }

  // 限流（非管理员）
  if (!(await isAuthAdmin(id, env))) {
    const rl = await checkRateLimit(id, env, ctx);
    if (!rl.allowed) {
      const warnKey = `rlwarn:${id}`;
      if (!hasLock(warnKey)) {
        setLock(warnKey, 10000);
        api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "⏳ 请求过于频繁，请稍后再试。" }).catch(e => log.warn('Private', 'send rate limit notice failed', { chatId: id, error: e?.message || String(e) }));
      }
      return;
    }
  }

  // Primary Admin 私聊命令 /reset <id>
  if (text.startsWith("/reset") && (await isPrimaryAdmin(id, env))) {
    const parts = text.trim().split(/\s+/);
    const target = (parts[1] || "").trim();
    if (!target || !/^\d+$/.test(target)) {
      return api(env.BOT_TOKEN, "sendMessage", {
        chat_id: id,
        text: "用法：/reset <user_id>\n示例：/reset 123456789"
      });
    }
    await forceResetUserVerify(target, env);
    api(env.BOT_TOKEN, "sendMessage", {
      chat_id: target,
      text: "⚠️ 管理员要求您重新验证。\n请发送 /start 重新完成验证流程。"
    }).catch(e => log.warn('Private', 'send reset notice to user failed', { target, error: e?.message || String(e) }));
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `✅ 已重置用户 ${target} 的验证状态。` });
  }

  // 管理员命令优先
  if (isStart) {
    if (await isPrimaryAdmin(id, env)) {
      if (ctx) ctx.waitUntil(registerCommands(env));
      return handleAdminConfig(id, null, "menu", null, null, env);
    }
  }

  if (text === "/help" && (await isAuthAdmin(id, env))) {
    return api(env.BOT_TOKEN, "sendMessage", {
      chat_id: id,
      text: "ℹ️ <b>帮助</b>\n• 回复消息即对话\n• /start 打开面板\n• /reset <id> 重置用户验证 (仅主管理员)",
      parse_mode: "HTML"
    });
  }

  if ((text === "/checkperms" || text === "/check_permissions") && (await isAuthAdmin(id, env))) {
    const loadingMsg = await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: id,
      text: "🔐 <b>权限检测中</b>\n\n正在检查各项权限...\n请稍候",
      parse_mode: "HTML"
    });

    try {
      const result = await checkAllPermissions(env);
      const reportHtml = formatPermissionReport(result);
      
      await api(env.BOT_TOKEN, "editMessageText", {
        chat_id: id,
        message_id: loadingMsg.result.message_id,
        text: reportHtml,
        parse_mode: "HTML"
      });
    } catch (e) {
      await api(env.BOT_TOKEN, "editMessageText", {
        chat_id: id,
        message_id: loadingMsg.result.message_id,
        text: `❌ <b>检测失败</b>\n\n错误信息：${escapeHTML(e.message)}\n\n请重试`,
        parse_mode: "HTML"
      });
    }
    
    return;
  }

  // 继续使用 u0，避免重复读
  const u = u0;

  // 管理员免验证
  if (await isAuthAdmin(id, env)) {
    if (u.user_state !== "verified") await updateUser(id, { user_state: "verified" }, env);
  }

  // 管理员状态机输入
  if (await isPrimaryAdmin(id, env)) {
    const stateStr = await getConfig(`admin_state:${id}`, env);
    if (stateStr) {
      const state = safeParse(stateStr);
      if (state.action === "input") return handleAdminInput(id, msg, state, env);
    }
  }

  // 验证拦截
  const verifyOn = await getBoolConfig("enable_verify", env);
  const qaOn = await getBoolConfig("enable_qa_verify", env);

  if (u.user_state !== "verified" && (verifyOn || qaOn)) {
    if (u.user_state === "pending_verification" && text) return verifyAnswer(id, text, env);
    return sendStart(id, msg, env);
  }

  // 已验证：/start 不再触发验证
  if (isStart) {
    if (u.topic_id) {
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: id,
        text: "✅ <b>会话已连接</b>\n您可以直接发送消息，管理员会收到。",
        parse_mode: "HTML"
      });
    } else {
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: id,
        text: "✅ 已验证。\n请直接发送消息以联系管理员。",
        parse_mode: "HTML"
      });
    }
    return;
  }

  await handleVerifiedMsg(msg, u, env, ctx);
}

/**
 * 发送 Start 流程
 * @param {string} id - 用户 ID
 * @param {Object} msg - Telegram 消息对象
 * @param {Object} env - 环境变量
 */
async function sendStart(id, msg, env) {
  const u = await getUser(id, env);

  // 若用户被屏蔽（保险校验）
  if (u.is_blocked && !(await isAuthAdmin(id, env))) {
    return api(env.BOT_TOKEN, "sendMessage", {
      chat_id: id,
      text: "🚫 您已被管理员屏蔽，无法使用本 Bot。"
    }).catch(e => log.warn('Private', 'send blocked notice failed', { chatId: id, error: e?.message || String(e) }));
  }

  if (u.user_state === "verified") {
    if (u.topic_id) {
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: id,
        text: "✅ <b>会话已连接</b>\n您可以直接发送消息，管理员会收到。",
        parse_mode: "HTML"
      });
    } else {
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: id,
        text: "✅ 已验证。\n请直接发送消息以联系管理员。",
        parse_mode: "HTML"
      });
    }
    return;
  }

  // 欢迎语
  let welcomeRaw = await getConfig("welcome_msg", env);
  const name = escapeHTML(msg.from.first_name || "User");
  let media = null, txt = welcomeRaw;
  try {
    if (welcomeRaw.trim().startsWith("{")) {
      media = safeParse(welcomeRaw, null);
      if (media) txt = media.caption || "";
    }
  } catch(e) {
    log.debug('Private', 'welcome message parse failed', { error: e?.message || String(e) });
  }
  txt = txt.replace(/{name}|{user}/g, name);

  if (media && media.type) {
    try {
      await api(env.BOT_TOKEN, `send${media.type.charAt(0).toUpperCase() + media.type.slice(1)}`, {
        chat_id: id,
        [media.type]: media.file_id,
        caption: txt,
        parse_mode: "HTML"
      });
    } catch(e) {
      log.warn('Private', 'send welcome media failed, fallback to text', { chatId: id, error: e?.message || String(e) });
      await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: txt, parse_mode: "HTML" });
    }
  } else {
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: txt, parse_mode: "HTML" });
  }

  // 发送验证流程
  await sendVerification(id, msg, env);
}

/**
 * 处理已验证用户消息
 * @param {Object} msg - Telegram 消息对象
 * @param {Object} u - 用户对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 */
async function handleVerifiedMsg(msg, u, env, ctx) {
  const id = u.user_id;

  // 保险：若中途被屏蔽（并发情况下），直接终止
  if (u.is_blocked && !(await isAuthAdmin(id, env))) return;

  // 反骚扰消息检测
  const msgCheck = await checkMessage(msg, env);
  if (msgCheck.triggered) {
    await handleMessageIntercept(id, msg.from, msgCheck.reason, env);
    return;
  }

  const greenEnabled = await getBoolConfig("enable_aliyun_green", env);
  const aiEnabled = await getBoolConfig("enable_ai_anti_harassment", env);

  if (greenEnabled) {
    const greenCheck = await checkGreenSpam(msg, u, env);
    if (greenCheck.spam) {
      await handleGreenSpamIntercept(id, msg.from, greenCheck.reason, greenCheck.riskLevel, greenCheck.labels, env);
      return;
    }
    if (!greenCheck.skipped && !greenCheck.error) {
      const promoted = await handleGreenCleanPass(id, env);
      if (promoted) {
        const notify = await getBoolConfig("aliyun_green_notify_auto_whitelist", env);
        if (notify && env.ADMIN_GROUP_ID) {
          const senderName = msg.from?.first_name || 'Unknown';
          const threshold = await getConfig("aliyun_green_trust_threshold", env) || 3;
          await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: `用户 ${senderName} 当日连续通过 ${threshold} 次 Green 检测，已加入信任列表（当日免检）`
          }).catch(e => log.debug('Private', 'send green whitelist notify failed', { error: e?.message || String(e) }));
        }
      }
    }
  } else if (aiEnabled) {
  const aiCheck = await checkAiSpam(msg, u, env);
  if (aiCheck.spam) {
    await handleAiSpamIntercept(id, msg.from, aiCheck.reason, env);
    return;
  }
  if (!aiCheck.skipped && !aiCheck.error) {
    const promoted = await handleAiCleanPass(id, env);
    if (promoted) {
      const notify = await getBoolConfig("ai_anti_harassment_notify_auto_whitelist", env);
      if (notify && env.ADMIN_GROUP_ID) {
        const senderName = msg.from?.first_name || 'Unknown';
        const threshold = await getConfig("ai_anti_harassment_trust_threshold", env) || 3;
        await api(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: `✅ 用户 ${senderName} 当日连续通过 ${threshold} 次 AI 检测，已加入 AI 信任列表（当日免检）`
        }).catch(e => log.debug('Private', 'send ai whitelist notify failed', { error: e?.message || String(e) }));
      }
    }
  }
  }

  const text = msg.text || msg.caption || "";

  // A. 屏蔽词检测
  if (text) {
    const kws = await getJsonConfig("block_keywords", env);
    const hit = (Array.isArray(kws) ? kws : []).some(k => safeRegexTest(k, text));
    if (hit) {
      const c = u.block_count + 1;
      const max = parseInt(await getConfig("block_threshold", env), 10) || 5;
      await updateUser(id, { block_count: c, is_blocked: c >= max }, env);

      if (c >= max) {
        const { manageBlacklist } = await import('../services/blacklist.js');
        await manageBlacklist(env, u, msg.from, true);
        return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 您已被系统自动封禁" });
      }
      return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `⚠️ 含有违禁词，请勿发送 (${c}/${max})` });
    }
  }

  // B. 类型过滤
  for (const t of MSG_TYPES) {
    if (t.check(msg)) {
      const enabled = t.extra ? await getBoolConfig(t.extra(msg), env) : await getBoolConfig(t.key, env);
      if (!enabled && !(await isAuthAdmin(id, env))) {
        return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `⚠️ 系统不接收 ${t.name}` });
      }
      break;
    }
  }

  // C. 自动回复
  if (text) {
    const rules = await getJsonConfig("keyword_responses", env);
    const match = (Array.isArray(rules) ? rules : []).find(r => r && safeRegexTest(r.keywords, text));
    if (match) api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: match.response }).catch(e => log.warn('Private', 'send auto-reply failed', { chatId: id, error: e?.message || String(e) }));
  }

  // D. 忙碌回复
  if (await getBoolConfig("busy_mode", env)) {
    const now = Date.now();
    if (now - (u.user_info.last_busy_reply || 0) > 300000) {
      api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "🌙 " + (await getConfig("busy_msg", env)) }).catch(e => log.warn('Private', 'send busy reply failed', { chatId: id, error: e?.message || String(e) }));
      await updateUser(id, { user_info: { last_busy_reply: now } }, env);
    }
  }

  // E. 转发
  await relayToTopic(msg, u, env, ctx);
}