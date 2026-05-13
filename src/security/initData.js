/**
 * Telegram initData 验签
 */

import { strToBytes, hmacSha256Bytes, bytesToHex, timingSafeEqualHex } from '../utils/helpers.js';

/**
 * 验证 Telegram WebApp initData
 * @param {string} initData - initData 字符串
 * @param {string} botToken - Bot Token
 * @param {number} maxAgeSec - 最大有效时间（秒）
 * @returns {Promise<Object>}
 */
export async function verifyTelegramInitData(initData, botToken, maxAgeSec) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!hash) throw new Error("missing hash");

  const authDateStr = params.get("auth_date") || "";
  const authDate = parseInt(authDateStr, 10);
  if (!authDate || !Number.isFinite(authDate)) throw new Error("missing auth_date");

  const nowSec = Math.floor(Date.now() / 1000);
  if (maxAgeSec && nowSec - authDate > maxAgeSec) throw new Error("expired");

  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (k === "hash") continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = await hmacSha256Bytes(strToBytes("WebAppData"), strToBytes(botToken));
  const calc = await hmacSha256Bytes(secretKey, strToBytes(dataCheckString));
  const calcHex = bytesToHex(calc);

  if (!timingSafeEqualHex(calcHex, hash)) throw new Error("hash mismatch");

  const userJson = params.get("user");
  let userId = "";
  let userObj = null;
  try {
    if (userJson) {
      userObj = JSON.parse(userJson);
      if (userObj && (userObj.id || userObj.id === 0)) userId = userObj.id.toString();
    }
  } catch {}

  return { userId, authDate, userObj };
}
