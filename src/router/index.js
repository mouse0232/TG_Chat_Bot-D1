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
import { genRequestId, log, logError } from '../utils/logger.js';

/**
 * 路由分发请求
 * @param {Request} req - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Worker 上下文
 * @returns {Promise<Response>}
 */
export async function route(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === 'POST') ctx.requestId = genRequestId();

  try {
    if (req.method === "GET") {
      if (url.pathname === "/verify") return handleVerifyPage(url, env);
      if (url.pathname === "/") return new Response("Bot v4.0 (Refactored)", { status: 200 });
    }

    if (req.method === "POST") {
      if (url.pathname === "/submit_token") return handleTokenSubmit(req, env, ctx);

      if (!isTelegramWebhook(req, env)) {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        const update = await req.json();
        const ok = await markUpdateOnce(update, env, ctx);
        if (!ok) return new Response("OK");

        ctx.waitUntil(handleUpdate(update, env, ctx));
        return new Response("OK");
      } catch {
        log.warn('Worker', 'Invalid request body', { requestId: ctx.requestId });
        return new Response("Bad Request", { status: 400 });
      }
    }
  } catch (e) {
    logError('Worker', 'Critical error', e, { requestId: ctx?.requestId });
    return new Response("Internal Server Error", { status: 500 });
  }

  return new Response("404 Not Found", { status: 404 });
}
