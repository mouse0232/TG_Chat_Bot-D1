/**
 * 验证页面处理器
 */

import { getVerifyPageHtml } from '../utils/templates.js';
import { getConfig } from '../database/config.js';

/**
 * 处理验证页面请求
 * @param {URL} url - 请求 URL
 * @param {Object} env - 环境变量
 * @returns {Response}
 */
export async function handleVerifyPage(url, env) {
  const uid = url.searchParams.get("user_id");
  const nonce = url.searchParams.get("nonce") || "";
  const mode = await getConfig("captcha_mode", env);
  const siteKey = mode === "recaptcha" ? env.RECAPTCHA_SITE_KEY : env.TURNSTILE_SITE_KEY;
  
  if (!uid || !siteKey) return new Response("Misconfigured", { status: 400 });

  const html = getVerifyPageHtml(uid, nonce, mode, siteKey);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
