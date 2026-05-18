import { log } from '../utils/logger.js';

const GREEN_API_VERSION = "2022-03-02";
const GREEN_ACTION = "TextModerationPlus";
const GREEN_SERVICE_DEFAULT = "ugc_moderation_byllm_cb";
const GREEN_REGION_DEFAULT = "ap-southeast-1";

function getGreenEndpoint(region) {
  return `green-cip.${region}.aliyuncs.com`;
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function hmacSha1(key, data) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function sortAndEncodeParams(params) {
  return Object.keys(params).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
}

async function signRequest(accessKeyId, accessKeySecret, params) {
  const canonicalizedQueryString = sortAndEncodeParams(params);
  const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonicalizedQueryString)}`;
  return hmacSha1(accessKeySecret + "&", stringToSign);
}

export async function callGreenApi(env, content) {
  const accessKeyId = env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = env.ALIYUN_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) throw new Error("ALIYUN_ACCESS_KEY_ID or ALIYUN_ACCESS_KEY_SECRET not configured");

  const timeout = parseInt(env.ALIYUN_GREEN_TIMEOUT_MS) || 5000;
  const region = env.ALIYUN_GREEN_REGION || GREEN_REGION_DEFAULT;
  const service = env.ALIYUN_GREEN_SERVICE || GREEN_SERVICE_DEFAULT;
  const endpoint = getGreenEndpoint(region);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  log.debug('Green', 'API call starting', { region, service, contentLen: content?.length });

  const serviceParameters = JSON.stringify({ content: content.substring(0, 2000) });

  const allParams = {
    Format: "JSON",
    Version: GREEN_API_VERSION,
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    Timestamp: timestamp,
    Action: GREEN_ACTION,
    Service: service,
    ServiceParameters: serviceParameters
  };

  const signature = await signRequest(accessKeyId, accessKeySecret, allParams);
  allParams.Signature = signature;

  const queryString = Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`https://${endpoint}/?${queryString}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal
    });

    clearTimeout(timer);

    const data = await response.json();
    log.debug('Green', 'API response received', { code: data.Code, riskLevel: data.Data?.RiskLevel });

    if (!response.ok) {
      throw new Error(`Green API returned ${response.status}: ${response.statusText}`);
    }

    if (data.Code !== 200) {
      throw new Error(`Green API error: Code ${data.Code} - ${data.Message}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}