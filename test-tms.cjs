const crypto = require("crypto");

const TMS_HOST = "tms.tencentcloudapi.com";
const TMS_ACTION = "TextModeration";
const TMS_VERSION = "2020-12-29";
const TMS_SERVICE = "tms";
const TMS_REGION = "ap-guangzhou";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function getDate(timestamp) {
  const d = new Date(timestamp * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function signRequest(secretId, secretKey, payload, timestamp) {
  const date = getDate(timestamp);
  const credentialScope = `${date}/${TMS_SERVICE}/tc3_request`;

  const hashedPayload = sha256(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TMS_HOST}\nx-tc-action:${TMS_ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST", "/", "", canonicalHeaders, signedHeaders, hashedPayload
  ].join("\n");

  const stringToSign = [
    "TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256(canonicalRequest)
  ].join("\n");

  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, TMS_SERVICE);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign).digest("hex");

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return authorization;
}

async function callTms(secretId, secretKey, content, timeout = 3000) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ Content: Buffer.from(content).toString("base64") });
  const authorization = signRequest(secretId, secretKey, payload, timestamp);

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
        "X-TC-Region": TMS_REGION,
        "Authorization": authorization
      },
      body: payload,
      signal: controller.signal
    });

    clearTimeout(timer);
    const data = await response.json();
    return data.Response;
  } finally {
    clearTimeout(timer);
  }
}

const LABEL_MAP = {
  Normal: "正常",
  Porn: "色情",
  Abuse: "辱骂",
  Ad: "广告",
  Illegal: "违法",
  Spam: "垃圾",
  Polity: "涉政",
  Terror: "暴恐",
  Custom: "自定义"
};

function formatResult(text, result) {
  if (result.Error) {
    return `[ERROR] ${result.Error.Code}: ${result.Error.Message}`;
  }
  const label = result.Label || "N/A";
  const suggestion = result.Suggestion || "N/A";
  const score = result.Score ?? "N/A";
  const keywords = result.Keywords || [];
  const zhLabel = LABEL_MAP[label] || label;

  const action = suggestion === "Block" ? "拦截" :
    suggestion === "Review" ? (score >= 60 ? "拦截(Review≥60)" : "放行(Review<60)") :
    "放行";

  return `Label: ${label}(${zhLabel}) | Suggestion: ${suggestion} | Score: ${score} | Keywords: ${keywords.join(",") || "无"} | 动作: ${action}`;
}

async function main() {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;

  if (!secretId || !secretKey) {
    console.error("请设置环境变量 TENCENT_SECRET_ID 和 TENCENT_SECRET_KEY");
    console.error("例如: TENCENT_SECRET_ID=AKIDxxx TENCENT_SECRET_KEY=xxx node test-tms.js");
    process.exit(1);
  }

  const testCases = [
    { name: "正常文本", text: "你好，请问今天天气怎么样？" },
    { name: "广告文本", text: "限时优惠！加微信 vx12345 免费领取优惠券，全场商品一折起！" },
    { name: "辱骂文本", text: "你个蠢货白痴，滚出去别在这里丢人现眼" },
    { name: "赌博广告", text: "澳门百家乐在线棋牌赌博游戏平台注册送88元" },
    { name: "混合内容", text: "今天工作很顺利，心情不错" },
  ];

  console.log("=== 腾讯 TMS 文本内容安全 API 测试 ===\n");

  for (const tc of testCases) {
    console.log(`[${tc.name}] 输入: "${tc.text}"`);
    try {
      const result = await callTms(secretId, secretKey, tc.text);
      console.log(`       结果: ${formatResult(tc.text, result)}`);
    } catch (err) {
      console.log(`       结果: [调用失败] ${err.message}`);
    }
    console.log();
  }
}

main().catch(console.error);