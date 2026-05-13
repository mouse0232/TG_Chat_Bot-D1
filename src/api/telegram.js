/**
 * Telegram Bot API 封装
 * 带重试退避机制
 */

/**
 * 调用 Telegram API
 * @param {string} token - Bot Token
 * @param {string} method - API 方法
 * @param {Object} body - 请求体
 * @returns {Promise<*>}
 */
export async function api(token, method, body) {
  const maxRetries = 3;
  const baseBackoff = [200, 500, 1200];
  const totalWaitCapMs = 10000;
  let waited = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const d = await r.json().catch(() => null);

      if (r.status >= 500) throw new Error(`HTTP_${r.status}`);

      if (!d || !d.ok) {
        const errCode = d?.error_code || r.status || 0;

        if (errCode === 429 && attempt < maxRetries) {
          const retryAfterSec = Number(d?.parameters?.retry_after || 0);
          const delayMs = Math.min(5000, Math.max(200, (retryAfterSec ? retryAfterSec * 1000 : baseBackoff[attempt] || 1200)));
          if (waited + delayMs > totalWaitCapMs) break;
          waited += delayMs;
          await sleep(delayMs);
          continue;
        }

        const desc = d?.description || `TG API Error (${errCode})`;
        if (method !== "setMessageReaction") console.warn(`TG API Error [${method}]:`, desc);
        throw new Error(desc);
      }

      return d.result;
    } catch (e) {
      if (attempt < maxRetries) {
        const delayMs = baseBackoff[attempt] || 1200;
        if (waited + delayMs > totalWaitCapMs) break;
        waited += delayMs;
        await sleep(delayMs);
        continue;
      }
      if (method !== "setMessageReaction") console.warn(`TG API Fail [${method}]:`, e?.message || e);
      throw e;
    }
  }

  throw new Error(`TG API Retry Exhausted: ${method}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
