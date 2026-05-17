import { log } from './logger.js';

/**
 * 通用辅助函数
 */

/**
 * 安全解析 JSON
 * @param {string} str - JSON 字符串
 * @param {*} fb - 解析失败时的回退值
 * @returns {*}
 */
export function safeParse(str, fb = {}) {
  try {
    return JSON.parse(str);
  } catch {
    return fb;
  }
}

/**
 * HTML 转义
 * @param {string} t - 原始文本
 * @returns {string}
 */
export function escapeHTML(t) {
  return (t || "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 生成随机 nonce
 * @param {number} len - 长度
 * @returns {string}
 */
export function genNonce(len = 24) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += (b % 36).toString(36);
  return s;
}

/**
 * 睡眠等待
 * @param {number} ms - 毫秒
 * @returns {Promise}
 */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 字符串转字节数组
 * @param {string} s
 * @returns {Uint8Array}
 */
export function strToBytes(s) {
  return new TextEncoder().encode(s);
}

/**
 * HMAC-SHA256
 * @param {Uint8Array} keyBytes
 * @param {Uint8Array} dataBytes
 * @returns {Promise<Uint8Array>}
 */
export async function hmacSha256Bytes(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

/**
 * 字节数组转十六进制
 * @param {Uint8Array} u8
 * @returns {string}
 */
export function bytesToHex(u8) {
  let out = "";
  for (const b of u8) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * 定时安全比较（十六进制）
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqualHex(a, b) {
  const aa = (a || "").toLowerCase();
  const bb = (b || "").toLowerCase();
  if (aa.length !== bb.length) return false;
  let r = 0;
  for (let i = 0; i < aa.length; i++) r |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return r === 0;
}

/**
 * 定时安全比较（字符串）
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqualStr(a, b) {
  const aa = (a || "").toString();
  const bb = (b || "").toString();
  if (aa.length !== bb.length) return false;
  let r = 0;
  for (let i = 0; i < aa.length; i++) r |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return r === 0;
}

/**
 * 获取用户元信息
 * @param {Object} tgUser - Telegram 用户对象
 * @param {Object} dbUser - 数据库用户对象
 * @param {number} d - 时间戳
 * @returns {Object}
 */
export function getUMeta(tgUser, dbUser, d) {
  const id = tgUser.id.toString();
  const name = (((tgUser.first_name || "") + " " + (tgUser.last_name || "")).trim() || tgUser.first_name || "User");
  const timeStr = new Date(d * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const note = dbUser.user_info?.note ? `\n📝 <b>备注:</b> ${escapeHTML(dbUser.user_info.note)}` : "";
  return {
    userId: id,
    name,
    topicName: `${name} | ${id}`.substring(0, 128),
    card: `<b>🪪 用户资料</b>\n👤: <code>${escapeHTML(name)}</code>\n🆔: <code>${escapeHTML(id)}</code>${note}\n🕒: <code>${escapeHTML(timeStr)}</code>`
  };
}

/**
 * 获取内联键盘按钮
 * @param {string} id - 用户 ID
 * @param {boolean} blk - 是否已屏蔽
 * @returns {Object}
 */
export function getBtns(id, blk) {
  return {
    inline_keyboard: [
      [{ text: "👤 主页", url: `tg://user?id=${id}` }],
      [{ text: blk ? "✅ 解封" : "🚫 屏蔽", callback_data: `${blk ? "unblock" : "block"}:${id}` }],
      [{ text: "✏️ 备注", callback_data: `note:set:${id}` }, { text: "📌 置顶", callback_data: `pin_card:${id}` }]
    ]
  };
}

/**
 * 解析 ID 列表为 Set
 * @param {string} str
 * @returns {Set}
 */
export function parseIdsToSet(str) {
  return new Set(
    (str || "")
      .toString()
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean)
  );
}


/**
 * 安全等待直到完成
 * @param {Object} ctx - Worker 上下文
 * @param {Promise} p - Promise
 */
export function safeWaitUntil(ctx, p) {
  try {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
    else p.catch(e => log.debug('Helpers', 'WaitUntil promise rejected', { error: e?.message || String(e) }));
  } catch {
    try {
      p.catch(e => log.debug('Helpers', 'WaitUntil promise rejected (fallback)', { error: e?.message || String(e) }));
    } catch(e) { log.debug('Helpers', 'WaitUntil fallback also failed', { error: e?.message || String(e) }); }
  }
}
