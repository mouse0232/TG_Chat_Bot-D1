/**
 * 反骚扰检测
 * 基于 Telegram Bot API 返回信息进行本地检测
 */

import { getBoolConfig } from '../database/config.js';
import { updateUser } from '../database/users.js';
import { getUser } from '../database/users.js';
import { api } from '../api/telegram.js';
import { manageBlacklist } from '../services/blacklist.js';
import { log, logError } from '../utils/logger.js';

const INTERCEPT_MSG = "❌ 您不符合聊天对象要求，无法使用本 Bot。";

const USER_RULES = [
  {
    name: "premium_user",
    config: "anti_harassment_allow_premium",
    check: (user) => user.is_premium === true,
    action: "allow",
    priority: 100
  },
  {
    name: "bot_account",
    config: "anti_harassment_block_bot",
    check: (user) => user.is_bot === true,
    action: "intercept",
    reason: "机器人账号",
    priority: 90
  },
  {
    name: "no_username",
    config: "anti_harassment_block_no_username",
    check: (user) => !user.username,
    action: "intercept",
    reason: "未设置用户名",
    priority: 80
  }
];

const MESSAGE_RULES = [
  {
    name: "bot_forward",
    config: "anti_harassment_block_bot_forward",
    check: (msg) => msg.forward_from?.is_bot === true,
    action: "intercept",
    reason: "转发机器人消息",
    priority: 90
  },
  {
    name: "inline_keyboard",
    config: "anti_harassment_block_inline_keyboard",
    check: (msg) => msg.reply_markup?.inline_keyboard?.length > 0,
    action: "intercept",
    reason: "包含内联键盘",
    priority: 80
  },
  {
    name: "mention",
    config: "anti_harassment_block_mention",
    check: (msg) => (msg.entities || []).some(e => e.type === "mention" || e.type === "text_mention"),
    action: "intercept",
    reason: "包含@提及",
    priority: 70
  }
];

export async function checkUser(user, env) {
  const enabled = await getBoolConfig("enable_anti_harassment", env);
  if (!enabled) return { triggered: false };

  const sorted = [...USER_RULES].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    const ruleEnabled = await getBoolConfig(rule.config, env);
    if (!ruleEnabled) continue;

    if (rule.action === "allow" && rule.check(user)) {
      return { triggered: false };
    }

    if (rule.action === "intercept" && rule.check(user)) {
      log.info('AntiHarass', 'Rule triggered', { userId: user.id, rule: rule.name, reason: rule.reason });
      return { triggered: true, reason: rule.reason, rule: rule.name };
    }
  }

  return { triggered: false };
}

export async function checkMessage(msg, env) {
  const enabled = await getBoolConfig("enable_anti_harassment", env);
  if (!enabled) return { triggered: false };

  const sorted = [...MESSAGE_RULES].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    const ruleEnabled = await getBoolConfig(rule.config, env);
    if (!ruleEnabled) continue;

    if (rule.check(msg)) {
      log.info('AntiHarass', 'Rule triggered', { userId: msg.from?.id, rule: rule.name, reason: rule.reason });
      return { triggered: true, reason: rule.reason, rule: rule.name };
    }
  }

  return { triggered: false };
}

export async function handleUserIntercept(userId, reason, env) {
  log.info('AntiHarass', 'User intercepted', { userId, reason });
  try {
    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: INTERCEPT_MSG
    }).catch(e => log.debug('AntiHarass', 'Intercept notification skipped', { userId, error: e?.message }));
  } catch (error) {
    logError('AntiHarass', 'Intercept failed', error, { userId });
  }
}

export async function handleMessageIntercept(userId, userInfo, reason, env) {
  log.info('AntiHarass', 'User intercepted', { userId, reason });
  try {
    await updateUser(userId, { is_blocked: true, user_info: { anti_harassment_reason: reason } }, env);
    const u = await getUser(userId, env);
    await manageBlacklist(env, u, userInfo, true);
    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: INTERCEPT_MSG
    }).catch(e => log.debug('AntiHarass', 'Intercept notification skipped', { userId, error: e?.message }));
  } catch (error) {
    logError('AntiHarass', 'Intercept failed', error, { userId });
  }
}