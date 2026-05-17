/**
 * Token 提交处理器
 */

import { api } from '../api/telegram.js';
import { getUser, updateUser } from '../database/users.js';
import { getBoolConfig, getConfig } from '../database/config.js';
import { checkSubmitRateLimit } from '../security/rateLimit.js';
import { verifyTelegramInitData } from '../security/initData.js';
import { VERIFY_NONCE_TTL_MS } from '../utils/constants.js';
import { log, logError, BusinessError } from '../utils/logger.js';

export async function handleTokenSubmit(req, env, ctx) {
  const requestId = ctx?.requestId;
  let uid = '';
  try {
    const body = await req.json();
    const token = body?.token;
    const uiUserId = (body?.userId || "").toString();
    const nonce = (body?.nonce || "").toString();
    const initData = (body?.initData || "").toString();
    const mode = await getConfig("captcha_mode", env);

    const rlPre = await checkSubmitRateLimit(req, env, ctx, "");
    if (!rlPre.allowed) throw new BusinessError("Rate limited", "rate_limited");

    if (!initData || initData.length < 20) throw new BusinessError("Missing initData", "missing_init_data");
    const parsed = await verifyTelegramInitData(initData, env.BOT_TOKEN, 600);
    uid = parsed?.userId?.toString();
    if (!uid) throw new BusinessError("Missing uid", "missing_uid");

    const rlUid = await checkSubmitRateLimit(req, env, ctx, uid);
    if (!rlUid.allowed) throw new BusinessError("Rate limited", "rate_limited");

    if (uiUserId && uiUserId !== uid) throw new BusinessError("uid mismatch", "uid_mismatch");

    const u = await getUser(uid, env);

    if (u.is_blocked) {
      const { isAuthAdmin } = await import('../utils/cache.js');
      if (!(await isAuthAdmin(uid, env))) throw new BusinessError("blocked", "blocked");
    }

    const savedNonce = (u.user_info?.verify_nonce || "").toString();
    const savedTs = Number(u.user_info?.verify_nonce_ts || 0);
    const now = Date.now();
    const expired = !savedTs || now - savedTs > VERIFY_NONCE_TTL_MS;

    if (u.user_state === "verified") {
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }

    const vOn = await getBoolConfig("enable_verify", env);
    if (vOn) {
      if (!nonce || !savedNonce || expired || nonce !== savedNonce) throw new BusinessError("nonce invalid", "nonce_invalid");
      await updateUser(uid, { user_info: { verify_nonce: "", verify_nonce_ts: 0 } }, env);
    }

    const verifyUrl =
      mode === "recaptcha"
        ? "https://www.google.com/recaptcha/api/siteverify"
        : "https://challenges.cloudflare.com/turnstile/v0/siteverify";

    const params =
      mode === "recaptcha"
        ? new URLSearchParams({ secret: env.RECAPTCHA_SECRET_KEY, response: token })
        : JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token });

    const headers =
      mode === "recaptcha"
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : { "Content-Type": "application/json" };

    const r = await fetch(verifyUrl, { method: "POST", headers, body: params });
    const d = await r.json();
    if (!d.success) throw new BusinessError("Token Invalid", "token_invalid");

    try {
      if (parsed?.userObj) {
        const nm = ((parsed.userObj.first_name || "") + " " + (parsed.userObj.last_name || "")).trim() || (parsed.userObj.first_name || "");
        const patch = {};
        if (nm) patch.name = nm;
        if (parsed.userObj.username) patch.username = parsed.userObj.username.toString();
        if (parsed.authDate) patch.join_date = parsed.authDate;
        if (Object.keys(patch).length) await updateUser(uid, { user_info: patch }, env);
      }
    } catch (e) {
      log.warn('TokenSubmit', 'User info update skipped', { uid, requestId, error: e.message });
    }

    const qaOn = await getBoolConfig("enable_qa_verify", env);
    if (qaOn) {
      await updateUser(uid, { user_state: "pending_verification" }, env);
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: uid,
        text: "✅ 验证通过！\n请继续回答：\n" + (await getConfig("verif_q", env))
      });
    } else {
      await updateUser(uid, { user_state: "verified" }, env);
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: uid,
        text: "✅ 验证通过！\n请直接发送消息以联系管理员。"
      });
    }

    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    if (e instanceof BusinessError) {
      log.warn('TokenSubmit', e.message, { uid, code: e.code, requestId });
      return new Response(JSON.stringify({ success: false, error: e.code }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    logError('TokenSubmit', 'Unexpected error', e, { uid, requestId });
    return new Response(JSON.stringify({ success: false, error: 'server_error' }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}