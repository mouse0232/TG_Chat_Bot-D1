/**
 * Webhook 安全校验
 */

import { timingSafeEqualStr } from '../utils/helpers.js';

/**
 * 校验是否为 Telegram Webhook 请求
 * @param {Request} req - 请求对象
 * @param {Object} env - 环境变量
 * @returns {boolean}
 */
export function isTelegramWebhook(req, env) {
  const secret = (env.TELEGRAM_WEBHOOK_SECRET || "").toString();
  if (!secret) return false;
  const hdr = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  return timingSafeEqualStr(hdr, secret);
}
