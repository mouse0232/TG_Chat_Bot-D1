const crypto = require("crypto");

const GREEN_API_VERSION = "2022-03-02";
const GREEN_ACTION = "TextModerationPlus";
const GREEN_SERVICE_DEFAULT = "ugc_moderation_byllm_cb";
const GREEN_REGION_DEFAULT = "ap-southeast-1";

function getGreenEndpoint(region) {
  return `green-cip.${region}.aliyuncs.com`;
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

function hmacSha1(key, data) {
  return crypto.createHmac("sha1", key).update(data).digest("base64");
}

function sortAndEncodeParams(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
}

function signRequest(accessKeyId, accessKeySecret, params) {
  const canonicalizedQueryString = sortAndEncodeParams(params);
  const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonicalizedQueryString)}`;
  return hmacSha1(accessKeySecret + "&", stringToSign);
}

async function callGreen(accessKeyId, accessKeySecret, content, options = {}) {
  const region = options.region || GREEN_REGION_DEFAULT;
  const service = options.service || GREEN_SERVICE_DEFAULT;
  const timeout = options.timeout || 5000;
  const endpoint = getGreenEndpoint(region);

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const serviceParameters = JSON.stringify({
    content: content.substring(0, 2000),
  });

  const allParams = {
    Format: "JSON",
    Version: GREEN_API_VERSION,
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: nonce,
    Timestamp: timestamp,
    Action: GREEN_ACTION,
    Service: service,
    ServiceParameters: serviceParameters,
  };

  const signature = signRequest(accessKeyId, accessKeySecret, allParams);
  allParams.Signature = signature;

  const queryString = Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`https://${endpoint}/?${queryString}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });

    clearTimeout(timer);
    const data = await response.json();
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const GREEN_LABEL_MAP = {
  nonLabel: "未检出风险",
  pornographic_adult: "色情内容",
  sexual_terms: "性健康内容",
  sexual_suggestive: "低俗内容",
  sexual_orientation: "性取向内容",
  regional_cn: "国内涉政内容",
  regional_illegal: "非法政治内容",
  regional_controversial: "政治争议",
  regional_racism: "种族主义",
  violent_extremist: "极端组织",
  violent_incidents: "极端主义内容",
  violent_weapons: "武器弹药",
  violence_unscList: "联合国制裁名单",
  contraband_drug: "毒品相关",
  contraband_gambling: "赌博相关",
  inappropriate_ethics: "不良价值观",
  inappropriate_profanity: "攻击辱骂",
  inappropriate_oral: "低俗口头语",
  inappropriate_religion: "宗教亵渎",
  pt_to_contact: "引流广告号",
  pt_to_sites: "站外引流",
  customized: "自定义违规",
};

function formatResult(result) {
  if (result.Code !== 200) {
    return `[ERROR] Code ${result.Code}: ${result.Message}`;
  }

  const data = result.Data || {};
  const riskLevel = data.RiskLevel || "none";
  const results = data.Result || [];

  if (riskLevel === "none" && results.length === 0) {
    return `RiskLevel: none | 无风险检测 | 动作: 放行`;
  }

  const labels = results
    .map((r) => {
      const zhLabel = GREEN_LABEL_MAP[r.Label] || r.Label;
      const conf = r.Confidence ?? "N/A";
      const words = r.RiskWords || "";
      return `${r.Label}(${zhLabel}): ${conf}分${words ? ` [${words}]` : ""}`;
    })
    .join("\n                 ");

  const action =
    riskLevel === "high"
      ? "拦截(high)"
      : riskLevel === "medium"
        ? "视Confidence决定(medium)"
        : "放行(low/none)";

  return `RiskLevel: ${riskLevel}\n                 ${labels}\n                 动作: ${action}`;
}

async function main() {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  const region = process.env.ALIYUN_GREEN_REGION || GREEN_REGION_DEFAULT;
  const service = process.env.ALIYUN_GREEN_SERVICE || GREEN_SERVICE_DEFAULT;

  if (!accessKeyId || !accessKeySecret) {
    console.error("请设置环境变量 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET");
    console.error(
      "例如: ALIYUN_ACCESS_KEY_ID=LTAIxxx ALIYUN_ACCESS_KEY_SECRET=xxx node test-green.cjs"
    );
    console.error("\n可选环境变量:");
    console.error("  ALIYUN_GREEN_REGION  - 地域 (默认: ap-southeast-1)");
    console.error("  ALIYUN_GREEN_SERVICE - 服务类型 (默认: ugc_moderation_byllm_cb)");
    process.exit(1);
  }

  const testCases = [
    { name: "正常中文", text: "你好，请问今天天气怎么样？" },
    { name: "正常英文", text: "Hello, how are you today? Nice weather!" },
    { name: "广告引流", text: "限时优惠！加微信 vx12345 免费领取优惠券，全场商品一折起！" },
    { name: "辱骂文本", text: "你个蠢货白痴，滚出去别在这里丢人现眼" },
    { name: "赌博内容", text: "澳门百家乐在线棋牌赌博游戏平台注册送88元" },
    { name: "混合内容", text: "今天工作很顺利，心情不错" },
    { name: "英文辱骂", text: "You are such a stupid idiot, get out of here" },
    { name: "英文赌博", text: "Online poker casino gambling game platform, sign up bonus $88" },
    { name: "日语正常", text: "今日はいい天気ですね。お散歩に行きましょう。" },
  ];

  console.log("=== 阿里云 Green 文本审核增强版 API 测试 ===");
  console.log(`    地域: ${region}`);
  console.log(`    服务: ${service}`);
  console.log(`    端点: ${getGreenEndpoint(region)}\n`);

  for (const tc of testCases) {
    console.log(`[${tc.name}] 输入: "${tc.text}"`);
    const start = Date.now();
    try {
      const result = await callGreen(accessKeyId, accessKeySecret, tc.text, {
        region,
        service,
      });
      const latency = Date.now() - start;
      console.log(`       延时: ${latency}ms`);
      console.log(`       结果: ${formatResult(result)}`);
    } catch (err) {
      const latency = Date.now() - start;
      console.log(`       延时: ${latency}ms`);
      console.log(`       结果: [调用失败] ${err.name === "AbortError" ? "超时" : err.message}`);
    }
    console.log();
  }
}

main().catch(console.error);