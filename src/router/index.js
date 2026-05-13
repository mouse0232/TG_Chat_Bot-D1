/**
 * 路由层
 * HTTP 请求路由分发
 */

import { handleUpdate } from '../handlers/update.js';
import { handleVerifyPage } from '../handlers/verifyPage.js';
import { handleTokenSubmit } from '../handlers/tokenSubmit.js';
import { isTelegramWebhook } from '../security/webhook.js';
import { markUpdateOnce } from '../security/idempotency.js';
import { safeWaitUntil } from '../utils/helpers.js';

/**
 * 路由分发请求
 * @param {Request} req - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 * @returns {Promise<Response>}
 */
export async function route(req, env, ctx) {
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      if (url.pathname === "/verify") return handleVerifyPage(url, env);
      if (url.pathname === "/") return new Response("Bot v4.0 (Refactored)", { status: 200 });
    }

    if (req.method === "POST") {
      // /submit_token：外部网页回调，不走 webhook secret，但必须限流 + 强验签
      if (url.pathname === "/submit_token") return handleTokenSubmit(req, env, ctx);

      // Webhook secret_token 校验：拒绝非 Telegram
      if (!isTelegramWebhook(req, env)) {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        const update = await req.json();

        // update 幂等去重
        const ok = await markUpdateOnce(update, env, ctx);
        if (!ok) return new Response("OK");

        ctx.waitUntil(handleUpdate(update, env, ctx));
        return new Response("OK");
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
    }
  } catch (e) {
    console.error("Critical Worker Error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }

  return new Response("404 Not Found", { status: 404 });
}
