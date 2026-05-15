/**
 * 腾讯云 TMS API 签名计算与调用
 * 使用 TC3-HMAC-SHA256 签名认证
 * Cloudflare Workers 环境下使用 Web Crypto API
 */

const TMS_SERVICE = "tms";
const TMS_HOST = "tms.tencentcloudapi.com";
const TMS_ACTION = "TextModeration";
const TMS_VERSION = "2020-12-29";
const TMS_REGION_DEFAULT = "ap-guangzhou";

async function hmacSha256(key, data) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return sig;
}

async function sha256(data) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function getDate(timestamp) {
  const d = new Date(timestamp * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function signRequest(secretId, secretKey, payload, timestamp) {
  const date = getDate(timestamp);
  const credentialScope = `${date}/${TMS_SERVICE}/tc3_request`;
  const hashedPayload = await sha256(payload);

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TMS_HOST}\nx-tc-action:${TMS_ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST", "/", "", canonicalHeaders, signedHeaders, hashedPayload
  ].join("\n");

  const hashedCanonicalRequest = await sha256(canonicalRequest);
  const stringToSign = [
    "TC3-HMAC-SHA256", String(timestamp), credentialScope, hashedCanonicalRequest
  ].join("\n");

  const secretDate = await hmacSha256(`TC3${secretKey}`, date);
  const secretService = await hmacSha256(secretDate, TMS_SERVICE);
  const secretSigning = await hmacSha256(secretService, "tc3_request");
  const signature = await hmacSha256(secretSigning, stringToSign);
  const signatureHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");

  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;
}

/**
 * 调用腾讯云 TMS TextModeration API
 * @param {Object} env - 环境变量
 * @param {string} content - 待检测文本内容
 * @returns {Promise<Object>} TMS Response 对象
 */
export async function callTmsApi(env, content) {
  const secretId = env.TENCENT_SECRET_ID;
  const secretKey = env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) throw new Error("TENCENT_SECRET_ID or TENCENT_SECRET_KEY not configured");

  const timeout = parseInt(env.TENCENT_TMS_TIMEOUT_MS) || 3000;
  const region = env.TENCENT_TMS_REGION || TMS_REGION_DEFAULT;
  const timestamp = Math.floor(Date.now() / 1000);

  console.log("[TMS] Calling API, region:", region, "text:", content.substring(0, 50));

  const payload = JSON.stringify({ Content: btoa(content) });
  const authorization = await signRequest(secretId, secretKey, payload, timestamp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`https://${TMS_HOST}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Host": TMS_HOST,
        "X-TC-Action": TMS_ACTION,
        "X-TC-Version": TMS_VERSION,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Region": region,
        "Authorization": authorization
      },
      body: payload,
      signal: controller.signal
    });

    clearTimeout(timer);

    const data = await response.json();
    console.log("[TMS] Response status:", response.status, "data:", JSON.stringify(data).substring(0, 200));

    if (!response.ok) {
      throw new Error(`TMS API returned ${response.status}: ${response.statusText}`);
    }

    if (data.Response?.Error) {
      throw new Error(`TMS API error: ${data.Response.Error.Code} - ${data.Response.Error.Message}`);
    }

    return data.Response;
  } finally {
    clearTimeout(timer);
  }
}
