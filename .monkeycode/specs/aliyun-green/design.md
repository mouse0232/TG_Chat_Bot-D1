# 集成阿里云内容安全/机器审核增强版/文本审核 - 技术设计文档

## 1. 架构设计

### 1.1 核心设计原则

**替换腾讯 TMS**

阿里云内容安全（Green）替换腾讯 TMS 作为第三方文本审核服务。两者定位相同：毫秒级响应的专业审核模型，与 AI 反骚扰互斥。替换后腾讯 TMS 代码保留但不再使用，配置开关从 `enable_tencent_tms` 切换到 `enable_aliyun_green`。

**与 AI 反骚扰互斥**

两种智能检测方式只能二选一。开启 Green 时自动关闭 AI，反之亦然。互斥通过配置开关和 adminConfig 处理逻辑双重保证。

**信任列表共享**

Green 与 AI 反骚扰共享同一张 `user_trust` 表和同一套信任机制。切换检测方式时信任数据不受影响。

**信任每日重置**

与 AI 反骚扰完全一致，跨天归零。

**使用出海版 + 新加坡地域**

选用 `ugc_moderation_byllm_cb`（UGC场景文本审核大模型服务_出海版），地域新加坡（ap-southeast-1），支持 119 种语言，满足境外业务需求。

### 1.2 模块位置

```
src/
├── security/
│   ├── antiHarassment.js              # 现有：本地反骚扰检测（不变）
│   ├── aiAntiHarassment.js            # 现有：AI 垃圾信息检测（不变）
│   ├── aiSpamPrompt.js                # 现有：LLM prompt 模板（不变）
│   ├── tencentTms.js                  # 保留：不再启用（保留代码供参考）
│   ├── tmsAntiHarassment.js           # 保留：不再启用（保留代码供参考）
│   ├── aliyunGreen.js                 # 新增：阿里云 Green API 签名 + 调用
│   ├── greenAntiHarassment.js         # 新增：Green 垃圾信息检测核心逻辑
│   ├── connectivityCheck.js           # 修改：新增 Green 连通性检测，保留 AI/TMS 检测
├── database/
│   ├── trust.js                       # 不变：信任度数据库操作（共享）
│   ├── index.js                       # 不变
│   ├── config.js                      # 不变
├── handlers/
│   ├── private.js                     # 修改：将 TMS 分支替换为 Green 分支
│   ├── adminReply.js                  # 不变：/trust /untrust 命令已实现
│   ├── adminConfig.js                 # 修改：新增 Green 反骚扰配置区域，TMS 入口改为 Green
│   ├── callback.js                    # 不变
├── services/
│   ├── blacklist.js                   # 不变：复用黑名单服务
│   └── relay.js                       # 不变：消息转发
├── utils/
│   └── constants.js                   # 修改：新增 Green 反骚扰默认配置
└── api/
    └── telegram.js                    # 不变：TG API 封装
```

### 1.3 检测流程集成点

```
用户消息进入
    │
    ▼
┌───────────────────────┐
│ 本地反骚扰检测         │
│ (antiHarassment.js)   │  ← 第一层：本地规则优先拦截
│ checkUser / checkMsg  │
└──────────┬────────────┘
           │ 通过
           ▼
┌───────────────────────┐     ┌───────────────────────┐
│ 黑名单检查             │────▶│ is_blocked → 终止流程  │
│ (users.is_blocked)    │     └───────────────────────┘
└──────────┬────────────┘
           │ 通过
           ▼
┌───────────────────────┐
│ 智能检测模式选择        │  ← 互斥分支
│                       │
│ 1. AI 开启？ → AI检测  │
│ 2. Green 开启？ → Green│
│ 3. 两者关闭 → 直接转发 │
└──────────┬────────────┘
           │ 通过/AI信任/Green信任
           ▼
┌───────────────────────┐
│ 屏蔽词/类型过滤/转发   │  ← 现有流程不变
└───────────────────────┘
```

## 2. 核心模块设计

### 2.1 `src/security/aliyunGreen.js`

**职责**：阿里云 Green API (TextModerationPlus) 签名计算与调用

**签名方式**：阿里云 API 使用 HMAC-SHA1 签名（不同于腾讯的 TC3-HMAC-SHA256）

签名流程：
1. 将所有请求参数（公共参数 + 业务参数）按字典序排列
2. 对参数名和值进行 URL 编码（RFC3986 规则：A-Z a-z 0-9 - _ . ~ 不编码，空格编码为 %20，+ 编码为 %2A，%7E 还原为 ~）
3. 用 = 连接编码后的参数名和值，再用 & 连接所有参数对，得到 CanonicalizedQueryString
4. 构造 StringToSign = METHOD + "&" + percentEncode("/") + "&" + percentEncode(CanonicalizedQueryString)
5. 用 AccessKeySecret + "&" 作为 HMAC-SHA1 的密钥，计算 StringToSign 的签名
6. Base64 编码签名结果，再 URL 编码，作为 Signature 参数

```javascript
const GREEN_API_VERSION = "2022-03-02";
const GREEN_ACTION = "TextModerationPlus";
const GREEN_SERVICE_DEFAULT = "ugc_moderation_byllm_cb";
const GREEN_REGION_DEFAULT = "ap-southeast-1";

function getGreenEndpoint(env) {
  const region = env.ALIYUN_GREEN_REGION || GREEN_REGION_DEFAULT;
  return `green-cip.${region}.aliyuncs.com`;
}

function percentEncode(str) {
  const encoded = encodeURIComponent(str);
  return encoded
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/%20/g, '%20');
  // 注意：不把 %20 换成 +，阿里云签名规范要求空格编码为 %20
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
  const keys = Object.keys(params).sort();
  return keys.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
}

async function signRequest(accessKeyId, accessKeySecret, params) {
  const canonicalizedQueryString = sortAndEncodeParams(params);
  const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonicalizedQueryString)}`;
  const signature = await hmacSha1(accessKeySecret + "&", stringToSign);
  return signature;
}

export async function callGreenApi(env, content) {
  const accessKeyId = env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = env.ALIYUN_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) throw new Error("ALIYUN_ACCESS_KEY_ID or ALIYUN_ACCESS_KEY_SECRET not configured");

  const timeout = parseInt(env.ALIYUN_GREEN_TIMEOUT_MS) || 5000;
  const endpoint = getGreenEndpoint(env);
  const service = env.ALIYUN_GREEN_SERVICE || GREEN_SERVICE_DEFAULT;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

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

    if (!response.ok) {
      throw new Error(`Green API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.Code !== 200) {
      throw new Error(`Green API error: Code ${data.Code} - ${data.Message}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}
```

**设计要点**：

1. **使用 Web Crypto API (HMAC-SHA1)**：阿里云签名使用 HMAC-SHA1（不同于腾讯的 HMAC-SHA256），Workers 的 `crypto.subtle` 支持 SHA-1 hash
2. **5 秒超时**：Green 大模型审核响应预期 1-3 秒，5 秒超时覆盖异常
3. **POST + QueryString 认证**：阿里云 API 签名参数放在 URL query string 中，业务参数（Service、ServiceParameters）也通过 query string 传递，HTTP method 为 POST
4. **出海版 + 新加坡**：默认 Service 为 `ugc_moderation_byllm_cb`，默认 Region 为 `ap-southeast-1`
5. **文本截断 2000 字符**：阿里云 API 限制文本不超过 2000 字符（不同于腾讯的 10000 字符）
6. **SignatureNonce 防重放**：使用时间戳 + 随机字符串生成唯一 nonce

### 2.2 `src/security/greenAntiHarassment.js`

**职责**：Green 垃圾信息检测核心逻辑

**导出函数**：

```javascript
/**
 * Green 垃圾信息检测
 * @param {Object} msg - Telegram Message 对象
 * @param {Object} user - DB 用户对象（含 trust_status）
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { spam, reason, labels, riskLevel, skipped, error }
 */
export async function checkGreenSpam(msg, user, env)

/**
 * 处理 Green 检测为垃圾的拦截动作
 * @param {string} userId - 用户 ID
 * @param {Object} userInfo - Telegram User 对象 (msg.from)
 * @param {string} reason - 检测原因（中文描述）
 * @param {string} riskLevel - 风险等级 (high/medium/low/none)
 * @param {Array} labels - 命中标签数组 [{label, description, confidence}]
 * @param {Object} env - 环境变量
 */
export async function handleGreenSpamIntercept(userId, userInfo, reason, riskLevel, labels, env)

/**
 * 处理 Green 检测为正常的通过动作（信任计数更新）
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} 是否被自动加信
 */
export async function handleGreenCleanPass(userId, env)
```

**Green 出海版风险标签中文映射**：

```javascript
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
  customized: "自定义违规"
};
```

**拦截判定逻辑**：

阿里云 Green API 返回 `RiskLevel`（high/medium/low/none）而非腾讯的 Suggestion（Block/Review/Pass）。拦截策略：

| RiskLevel | 动作 | 说明 |
|-----------|------|------|
| **high** | 拦截 | 高风险，建议直接处置 |
| **medium** | 根据 Confidence 阈值决定 | 中风险，建议人工复查；Confidence >= 阈值时拦截 |
| **low** | 放行 | 低风险，日常建议与 none 相同处理 |
| **none** | 放行 | 未检测到风险 |

**核心实现逻辑**：

```javascript
import { getBoolConfig, getConfig } from '../database/config.js';
import { getUserTrust, incrementCleanCount, recordSpam, checkAndPromoteToWhitelist } from '../database/trust.js';
import { updateUser } from '../database/users.js';
import { manageBlacklist } from '../services/blacklist.js';
import { api } from '../api/telegram.js';
import { callGreenApi } from './aliyunGreen.js';
import { log, logError } from '../utils/logger.js';

const SPAM_INTERCEPT_MSG = "您的消息因包含垃圾信息已被过滤。如有疑问，请联系管理员。";

export async function checkGreenSpam(msg, user, env) {
  const enabled = await getBoolConfig("enable_aliyun_green", env);
  if (!enabled) return { spam: false, skipped: true };

  const text = msg.text || msg.caption || "";
  if (!text) return { spam: false, skipped: true, reason: "非文本消息跳过Green检测" };

  let trustInfo = await getUserTrust(user.user_id, env);
  if (!trustInfo) {
    await import('../database/trust.js').then(m => m.createUserTrust(user.user_id, msg.from?.username, env));
    trustInfo = await getUserTrust(user.user_id, env);
  }

  if (trustInfo?.trust_status === 'trusted') {
    return { spam: false, skipped: true, reason: "信任用户跳过检测" };
  }

  const truncatedText = text.substring(0, 2000);

  try {
    const greenResult = await callGreenApi(env, truncatedText);
    const data = greenResult.Data;
    const riskLevel = data?.RiskLevel || "none";
    const results = data?.Result || [];

    if (riskLevel === "high") {
      const topResult = results.sort((a, b) => b.Confidence - a.Confidence)[0];
      const reason = GREEN_LABEL_MAP[topResult?.Label] || topResult?.Description || "Green检测为高风险内容";
      return { spam: true, reason, labels: results, riskLevel, skipped: false };
    }

    if (riskLevel === "medium") {
      const mediumThreshold = parseFloat(await getConfig("aliyun_green_medium_block_threshold", env)) || 80;
      const maxConfidence = results.length > 0 ? Math.max(...results.map(r => r.Confidence || 0)) : 0;
      if (maxConfidence >= mediumThreshold) {
        const topResult = results.sort((a, b) => b.Confidence - a.Confidence)[0];
        const reason = GREEN_LABEL_MAP[topResult?.Label] || topResult?.Description || "Green检测为中高风险内容";
        return { spam: true, reason, labels: results, riskLevel, skipped: false };
      }
    }

    return { spam: false, labels: results, riskLevel, skipped: false };
  } catch (error) {
    logError('GreenAntiHarass', 'Green API call failed', error);
    return { spam: false, skipped: false, error: true };
  }
}

export async function handleGreenSpamIntercept(userId, userInfo, reason, riskLevel, labels, env) {
  log.info('GreenAntiHarass', 'User intercepted', { userId, reason, riskLevel });
  try {
    await recordSpam(userId, env);
    const labelSummary = labels?.map(l => `${GREEN_LABEL_MAP[l.Label] || l.Label}(${l.Confidence}分)`).join(', ') || reason;
    await updateUser(userId, { is_blocked: true, user_info: { green_spam_reason: reason, green_risk_level: riskLevel, green_labels: labelSummary } }, env);
    const u = await import('../database/users.js').then(m => m.getUser(userId, env));
    await manageBlacklist(env, u, userInfo, true);

    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: SPAM_INTERCEPT_MSG
    }).catch(e => log.debug('GreenAntiHarass', 'Notification skipped', { userId, error: e?.message }));

    if (env.ADMIN_GROUP_ID) {
      const now = new Date();
      const utcPlus8Ms = now.getTime() + 8 * 60 * 60 * 1000;
      const d = new Date(utcPlus8Ms);
      const timeStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
      const senderName = `${userInfo?.first_name || ''}${userInfo?.last_name ? ' ' + userInfo.last_name : ''}`.trim() || 'Unknown';
      const uname = userInfo?.username ? ` (@${userInfo.username})` : '';
      const labelDetail = labels?.map(l => `${GREEN_LABEL_MAP[l.Label] || l.Label}: ${l.Confidence}分`).join('\n') || reason;
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        text: `[Green] \u5783\u573E\u4FE1\u606F\u8B66\u540A\n\n\u53D1\u9001\u8005: ${senderName}${uname} (ID: ${userId})\n\u98CE\u9669\u7B49\u7EA7: ${riskLevel}\n${labelDetail}\n\u65F6\u95F4: ${timeStr}`,
        parse_mode: "HTML"
      }).catch(e => log.debug('GreenAntiHarass', 'Admin notification skipped', { userId, error: e?.message }));
    }
  } catch (error) {
    logError('GreenAntiHarass', 'Intercept failed', error, { userId });
  }
}

export async function handleGreenCleanPass(userId, env) {
  try {
    await incrementCleanCount(userId, env);
    const threshold = parseInt(await getConfig("aliyun_green_trust_threshold", env)) || 3;
    const promoted = await checkAndPromoteToWhitelist(userId, env, threshold);
    if (promoted) {
      log.info('GreenAntiHarass', 'User promoted to trust', { userId });
    }
    return promoted;
  } catch (error) {
    logError('GreenAntiHarass', 'Clean pass failed', error, { userId });
    return false;
  }
}
```

**设计要点**：

1. **RiskLevel 映射**：high → 拦截；medium → 根据 Confidence 阈值决定（默认 >= 80 拦截）；low/none → 放行
2. **标签中文映射**：出海版标签与国内版不同，使用专门的出海版标签映射表
3. **管理员通知增强**：列出所有命中标签及置信度分数，而非仅单一 Label
4. **复用信任模块**：`incrementCleanCount`、`recordSpam`、`checkAndPromoteToWhitelist` 直接复用 trust.js
5. **信任阈值区分**：`handleGreenCleanPass` 传入 `aliyun_green_trust_threshold`

### 2.3 `src/database/trust.js` — 无修改

信任表和数据操作完全共享，无需修改。`checkAndPromoteToWhitelist` 已支持自定义阈值参数。

### 2.4 `src/handlers/private.js` 修改

**修改点**：将 TMS 分支替换为 Green 分支

```javascript
// 修改 import
import { checkGreenSpam, handleGreenSpamIntercept, handleGreenCleanPass } from '../security/greenAntiHarassment.js';
// 移除 TMS import（保留代码但不再引用）
// import { checkTmsSpam, handleTmsSpamIntercept, handleTmsCleanPass } from '../security/tmsAntiHarassment.js';

async function handleVerifiedMsg(msg, u, env, ctx) {
  const id = u.user_id;

  if (u.is_blocked && !(await isAuthAdmin(id, env))) return;

  const msgCheck = await checkMessage(msg, env);
  if (msgCheck.triggered) {
    await handleMessageIntercept(id, msg.from, msgCheck.reason, env);
    return;
  }

  const greenEnabled = await getBoolConfig("enable_aliyun_green", env);
  const aiEnabled = await getBoolConfig("enable_ai_anti_harassment", env);

  if (greenEnabled) {
    const greenCheck = await checkGreenSpam(msg, u, env);
    if (greenCheck.spam) {
      await handleGreenSpamIntercept(id, msg.from, greenCheck.reason, greenCheck.riskLevel, greenCheck.labels, env);
      return;
    }
    if (!greenCheck.skipped && !greenCheck.error) {
      const promoted = await handleGreenCleanPass(id, env);
      if (promoted) {
        const notify = await getBoolConfig("aliyun_green_notify_auto_whitelist", env);
        if (notify && env.ADMIN_GROUP_ID) {
          const senderName = msg.from?.first_name || 'Unknown';
          const threshold = await getConfig("aliyun_green_trust_threshold", env) || 3;
          await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: `用户 ${senderName} 当日连续通过 ${threshold} 次 Green 检测，已加入信任列表（当日免检）`
          }).catch(() => {});
        }
      }
    }
  } else if (aiEnabled) {
    // AI 分支不变...
  }

  // 后续逻辑不变...
}
```

**互斥保证**：代码层面按 Green > AI 的优先级检查。配置层面开启一个自动关闭另一个。

### 2.5 `src/handlers/adminConfig.js` 修改

**新增 Green 配置面板** 和 **互斥控制逻辑**

**菜单层修改**：将 TMS 入口替换为 Green 入口

```javascript
// 主菜单修改
[
  { text: "\u{1F916} AI\u53CD\u9A9A\u6311", callback_data: "config:menu:aiah" },
  { text: "\u{1F6E1} Green\u53CD\u9A9A\u6311", callback_data: "config:menu:green" }  // 替换 TMS
]
```

**Green 配置面板** (key === "green")：

```javascript
if (key === "green") {
  const greenEnabled = await getBoolConfig("enable_aliyun_green", env);
  const threshold = await getConfig("aliyun_green_trust_threshold", env) || 3;
  const notifyAuto = await getBoolConfig("aliyun_green_notify_auto_whitelist", env);
  const mediumThreshold = await getConfig("aliyun_green_medium_block_threshold", env) || 80;
  const t = (v) => v ? "✅" : "❌";
  const secretReady = !!env.ALIYUN_ACCESS_KEY_ID && !!env.ALIYUN_ACCESS_KEY_SECRET;
  const secretStatus = secretReady ? "✅ 已配置" : "❌ 未配置密钥";
  const service = env.ALIYUN_GREEN_SERVICE || "ugc_moderation_byllm_cb";
  const region = env.ALIYUN_GREEN_REGION || "ap-southeast-1";

  return render(`\u{1F6E1} <b>Green 反骚扰检测</b>\n总开关: ${t(greenEnabled)}\n密钥配置: ${secretStatus}\n服务类型: ${service}\n使用地域: ${region}\n信任阈值: 当日连续通过 ${threshold} 次\nMedium拦截阈值: Confidence >= ${mediumThreshold}\n加信通知: ${t(notifyAuto)}\n\n<b>说明</b>\n- 阿里云Green出海版支持119种语言\n- 与AI反骚扰<b>互斥</b>，开启Green自动关闭AI\n- 信任列表与AI共享<b>同一套</b>${!secretReady ? "\n\n⚠️ <b>请先配置密钥再开启</b>" : ""}`, {
    inline_keyboard: [
      [{ text: `总开关: ${t(greenEnabled)}${!secretReady && !greenEnabled ? " (需先配置密钥)" : ""}`, callback_data: `config:toggle:enable_aliyun_green:${!greenEnabled}` }],
      [{ text: `信任阈值: ${threshold}`, callback_data: `config:edit:aliyun_green_trust_threshold` }],
      [{ text: `Medium阈值: ${mediumThreshold}`, callback_data: `config:edit:aliyun_green_medium_block_threshold` }],
      [{ text: `加信通知: ${t(notifyAuto)}`, callback_data: `config:toggle:aliyun_green_notify_auto_whitelist:${!notifyAuto}` }],
      [{ text: "🔍 检测连通性", callback_data: "config:check:green" }],
      [back]
    ]
  });
}
```

**互斥控制** (toggle 处理)：

```javascript
if (type === "toggle") {
  // 开启 Green 时自动关闭 AI，并校验密钥 + 连通性
  if (key === "enable_aliyun_green" && val === "true") {
    if (!env.ALIYUN_ACCESS_KEY_ID || !env.ALIYUN_ACCESS_KEY_SECRET) {
      return render("❌ <b>无法开启 Green 反骚扰</b>\n\n未配置阿里云密钥。\n请在 Cloudflare Dashboard 或 wrangler secret 中设置以下变量后重试：\n\n<b>必需</b>:\n• ALIYUN_ACCESS_KEY_ID — 阿里云 AccessKey ID\n• ALIYUN_ACCESS_KEY_SECRET — 阿里云 AccessKey Secret\n\n<b>可选</b>:\n• ALIYUN_GREEN_REGION — API 地域 (默认 ap-southeast-1)\n• ALIYUN_GREEN_SERVICE — 检测服务 (默认 ugc_moderation_byllm_cb)\n• ALIYUN_GREEN_TIMEOUT_MS — 超时毫秒数 (默认 5000)", {
        inline_keyboard: [[{ text: "🔙 返回 Green 反骚扰", callback_data: "config:menu:green" }]]
      });
    }

    const check = await checkGreenConnectivity(env);
    if (!check.ok) {
      return render(`❌ <b>Green 反骚扰连通性检测失败</b>\n\n无法开启，Green API 不可达。\n延时: ${check.latencyMs}ms\n错误: ${escapeHTML(check.error || "")}\n\n请先修复连通性问题再开启。`, {
        inline_keyboard: [[{ text: "🔙 返回 Green 反骚扰", callback_data: "config:menu:green" }]]
      });
    }

    await setConfig("enable_ai_anti_harassment", "false", env);
  }

  // 开启 AI 时自动关闭 Green
  if (key === "enable_ai_anti_harassment" && val === "true") {
    // 现有的 AI 校验逻辑...
    await setConfig("enable_aliyun_green", "false", env);
  }

  await setConfig(key, val, env);
  const greenKeys = ["enable_aliyun_green", "aliyun_green_notify_auto_whitelist"];
  if (greenKeys.includes(key)) return handleAdminConfig(cid, mid, "menu", "green", null, env);
  // ... 现有逻辑
}
```

**连通性检测** (check 处理)：

```javascript
if (type === "check") {
  if (key === "green") {
    log.debug('Config', 'starting Green connectivity check');
    const result = await checkGreenConnectivity(env);
    log.debug('Config', 'Green connectivity check result', { result });

    if (result.ok) {
      const detail = result.riskLevel ? `\nRiskLevel: ${result.riskLevel}` : '';
      return render(`\u{1F6E1} Green \u8FDE\u901A\u6027\u68C0\u6D4B\n\n\u2713 \u8FDE\u901A\u6210\u529F\n\u5EF0\u65F6: ${result.latencyMs}ms${detail}\nGreen API \u53EF\u6B63\u5E38\u8C03\u7528`, {
        inline_keyboard: [[{ text: "\u{1F6E1} Green\u53CD\u9A9A\u6311", callback_data: "config:menu:green" }]]
      });
    }

    return render(`\u{1F6E1} Green \u8FDE\u901A\u6027\u68C0\u6D4B\n\n\u2717 \u8FDE\u901A\u5931\u8D25\n\u5EF0\u65F6: ${result.latencyMs}ms\n\u9519\u8BEF: ${escapeHTML(result.error || "")}\n\n<b>\u5EFA\u8BAE</b>:\n1. \u68C0\u67E5 ALIYUN_ACCESS_KEY_ID/SECRET \u662F\u5426\u6B63\u7866\n2. \u786E\u8BA4\u963F\u91CC\u4E91\u5185\u5BB9\u5B89\u5168\u670D\u52A1\u5DF2\u5F00\u901A\n3. \u68C0\u67E5 ALIYUN_GREEN_REGION \u503C\u662F\u5426\u6B63\u7866`, {
      inline_keyboard: [[{ text: "\u{1F6E1} Green\u53CD\u9A9A\u6311", callback_data: "config:menu:green" }]]
    });
  }
  // ... 现有 AI/TMS check 逻辑保留
}
```

### 2.6 `src/security/connectivityCheck.js` 修改

**新增 Green 连通性检测函数**：

```javascript
import { callGreenApi } from './aliyunGreen.js';

const GREEN_TEST_TEXT = "test";

export async function checkGreenConnectivity(env) {
  if (!env.ALIYUN_ACCESS_KEY_ID || !env.ALIYUN_ACCESS_KEY_SECRET) {
    return { ok: false, latencyMs: 0, error: "ALIYUN_ACCESS_KEY_ID/SECRET 未配置" };
  }

  const start = Date.now();
  try {
    const result = await callGreenApi(env, GREEN_TEST_TEXT);
    const latencyMs = Date.now() - start;

    if (result.Code !== 200) {
      return { ok: false, latencyMs, error: `Code ${result.Code}: ${result.Message}` };
    }

    const riskLevel = result.Data?.RiskLevel;
    if (!riskLevel) {
      return { ok: false, latencyMs, error: "Green 响应结构异常：缺少 RiskLevel" };
    }

    return { ok: true, latencyMs, error: null, riskLevel };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err.name === "AbortError" ? "API 超时" : err.message;
    return { ok: false, latencyMs, error: msg };
  }
}
```

保留现有的 `checkAiConnectivity` 和 `checkTmsConnectivity` 函数不删除。

### 2.7 `src/utils/constants.js` 修改

**新增默认配置**（替换/追加 TMS 配置）：

```javascript
// DEFAULTS 新增
enable_aliyun_green: "false",
aliyun_green_trust_threshold: "3",
aliyun_green_medium_block_threshold: "80",
aliyun_green_notify_auto_whitelist: "true"

// TMS 配置保留（不再启用）
enable_tencent_tms: "false",
tencent_tms_trust_threshold: "3",
tencent_tms_review_block_threshold: "60",
tencent_tms_notify_auto_whitelist: "true"
```

### 2.8 数据库表无需修改

`user_trust` 表已存在且共享，无需新建表。信任数据在 AI 和 Green 模式下通用。

## 3. 接口设计

### 3.1 阿里云 TextModerationPlus API 调用

使用 HMAC-SHA1 签名认证，通过原生 fetch 调用：

```
POST https://green-cip.ap-southeast-1.aliyuncs.com/?<签名参数+业务参数>

公共参数（Query String）:
  Format=JSON
  Version=2022-03-02
  AccessKeyId=<阿里云 AccessKey ID>
  SignatureMethod=HMAC-SHA1
  SignatureVersion=1.0
  SignatureNonce=<唯一随机数>
  Timestamp=<ISO8601 UTC 时间戳>
  Action=TextModerationPlus
  Signature=<HMAC-SHA1 签名>

业务参数（Query String）:
  Service=ugc_moderation_byllm_cb
  ServiceParameters={"content":"<待检测文本>"}

Response:
{
  "Code": 200,
  "Data": {
    "Result": [
      {
        "Label": "inappropriate_profanity",
        "Description": "疑似攻击辱骂内容",
        "Confidence": 81.22,
        "RiskWords": "敏感词1,敏感词2"
      }
    ],
    "RiskLevel": "high",
    "DataId": "xxx"
  },
  "Message": "OK",
  "RequestId": "xxx"
}
```

### 3.2 内部接口总览

```javascript
// aliyunGreen.js
callGreenApi(env, content)                  → Green API 响应对象

// greenAntiHarassment.js
checkGreenSpam(msg, user, env)              → { spam, reason, labels, riskLevel, skipped, error }
handleGreenSpamIntercept(userId, userInfo, reason, riskLevel, labels, env) → void
handleGreenCleanPass(userId, env)           → boolean (是否晋升信任列表)

// connectivityCheck.js (新增)
checkGreenConnectivity(env)                 → { ok, latencyMs, error, riskLevel }

// trust.js (不变，共享使用)
checkAndPromoteToWhitelist(userId, env, customThreshold?) → boolean
```

## 4. 数据流设计

### 4.1 Green 垃圾信息检测数据流

```
msg (Telegram Message) + user (DB User)
    │
    ▼
┌───────────────────┐
│ checkGreenSpam()  │
│                   │
│ 1. 总开关检查     │ → 关闭 → { spam: false, skipped: true }
│ 2. 文本检查       │ → 无文本 → { spam: false, skipped: true }
│ 3. 信任检查       │ → trusted → { spam: false, skipped: true }
│ 4. 获取信任记录   │ → 无记录 → createUserTrust()
│ 5. callGreenApi() │ → 超时/错误 → { spam: false, error: true }
│ 6. RiskLevel映射  │
│    - high → spam  │
│    - medium +     │
│      Confidence   │
│      >= 阈值      │ → spam
│    - low/none →   │
│      clean        │
└──────────┬────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
  CLEAN        SPAM
     │           │
     ▼           ▼
 handleGreen   handleGreen
 CleanPass()   SpamIntercept()
     │           │
     ▼           ▼
 incrementClean 1. recordSpam()
 Count()         2. updateUser({is_blocked: true,
     │              user_info: {green_risk_level, green_labels}})
     ▼           3. manageBlacklist()
 checkAndPromote 4. 发送拦截提示
 ToWhitelist()   5. 通知管理员（含RiskLevel/所有Label/Confidence）
     │
     ▼
   达到阈值 → trustUser('auto')
   未达阈值 → 继续
```

### 4.2 管理员通知数据流

```
Green 检测为 high 或 medium(>=阈值)
    │
    ▼
┌───────────────────┐
│ handleGreen        │
│ SpamIntercept()    │
│                   │
│ 1. 发送拦截提示    │ → 用户收到 "您的消息因包含垃圾信息已被过滤"
│ 2. recordSpam()   │ → D1: trust_status=monitoring, count=0, spam+1
│ 3. updateUser()   │ → D1: is_blocked=true, user_info={green_spam_reason, green_risk_level, green_labels}
│ 4. manageBlacklist│ → 管理群组黑名单通知
│ 5. 发送 Green 报告│ → 管理群组收到：
│                   │   "[Green] 垃圾信息警告
│                   │    发送者: xxx (@xxx) (ID: xxx)
│                   │    风险等级: high
│                   │    攻击辱骂: 81.22分
│                   │    站外引流: 65.0分
│                   │    时间: 2026-05-17 12:00:00"
└───────────────────┘
```

## 5. 错误处理

### 5.1 Green API 调用失败

```javascript
try {
  const greenResult = await callGreenApi(env, truncatedText);
  // 处理结果...
} catch (error) {
  logError('GreenAntiHarass', 'Green API call failed', error);
  // fail-open：不阻断消息，允许通过
  return { spam: false, skipped: false, error: true };
}
```

### 5.2 超时处理

```javascript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeout);
// fetch signal: controller.signal
// 超时触发 AbortError，进入 catch → fail-open
```

### 5.3 签名计算失败

Web Crypto API 在 Workers 中始终可用，但若 AccessKeyId/AccessKeySecret 为空则直接抛错，进入 fail-open。

### 5.4 Green 返回非 200 Code

```javascript
if (data.Code !== 200) {
  throw new Error(`Green API error: Code ${data.Code} - ${data.Message}`);
}
// 进入 catch → fail-open
```

### 5.5 错误汇总

| 错误场景 | 处理策略 | 用户影响 |
|----------|----------|----------|
| Green API 返回非 200 HTTP status | fail-open，记录错误日志 | 消息正常转发 |
| Green API 返回 Code != 200 | fail-open，记录 Code 和 Message | 消息正常转发 |
| Green API 超时（5s） | fail-open（AbortController） | 消息正常转发 |
| 签名密钥未配置 | fail-open | 消息正常转发 |
| 信任数据操作失败 | 记录日志，不阻断 | 消息正常转发，下次重试 |
| 拦截处理失败 | 记录日志，不抛异常 | 用户可能收到部分通知 |

## 6. 性能考虑

### 6.1 API 调用延迟

| 场景 | 延迟 |
|------|------|
| 信任用户 | 0ms（跳过检测） |
| 非信任用户 | ~1-3s（Green 大模型审核） |
| 超时上限 | 5s（AbortController） |
| AI 反骚扰对比 | 1-5s（LLM API） |
| 腾讯 TMS 对比 | <100ms |

Green 大模型审核版响应比传统 TMS 版（毫秒级）慢，但与 AI 反骚扰（LLM API）相当。这是选择大模型审核版本的代价，换来的是更强的语义理解能力和多语言支持（119种语言）。

### 6.2 成本控制

- 信任列表系统：trusted 用户完全跳过 Green 调用
- 仅文本消息检测：非文本消息仅本地检测
- 默认关闭：`enable_aliyun_green` 默认 `false`
- 阿里云计费：20元/万次（按量后付费），也可购买资源包（抵扣系数2.67）

### 6.3 Workers 限制

- Cloudflare Workers CPU 时间限制：30s（paid），10s（free）
- fetch 调用不计入 CPU 时间（subrequest）
- HMAC-SHA1 签名计算：~1ms（Web Crypto API）
- 5s 超时确保不超出 Workers 限制

### 6.4 签名计算性能

- `crypto.subtle.importKey` + `sign` 为异步操作，但 Workers 环境下极快
- HMAC-SHA1 比 TC3-HMAC-SHA256 简单（仅需1次 HMAC 计算，腾讯需要4次）
- 签名开销 ~1ms，对总延迟影响微不足道

### 6.5 QPS 限制

阿里云 Green API 单用户 QPS 限制为 50次/秒，远超 Telegram Bot 实际消息频率需求。

## 7. 安全考虑

### 7.1 阿里云密钥安全

- 环境变量存储，不硬编码
- Workers Secrets 管理（`wrangler secret put ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`）
- 不在日志中输出密钥

### 7.2 防误判

- medium 结果需要 Confidence >= 阈值（默认 80）才拦截，避免误杀
- fail-open 策略：Green 不可用时放行
- 信任用户完全免检
- 管理员不受检测影响

### 7.3 防绕过

- 本地检测 + Green 检测双重屏障
- 信任列表仅当日有效，每日重置
- 黑名单优先于信任列表
- 管理员可随时 /untrust 移出信任列表
- 信任列表与黑白名单完全解耦

### 7.4 签名安全

- HMAC-SHA1 为阿里云标准签名方法
- SignatureNonce 防止重放攻击
- Timestamp 参数防止签名过期使用
- 签名中包含所有请求参数，防止篡改

## 8. 测试策略

### 8.1 单元测试

```javascript
describe("aliyunGreen - HMAC-SHA1 签名", () => {
  test("签名计算正确", async () => {
    const signature = await signRequest("testKeyId", "testKeySecret", {
      Format: "JSON",
      Version: "2022-03-02",
      Action: "TextModerationPlus"
    });
    expect(signature).toBeTruthy();
  });
});

describe("checkGreenSpam", () => {
  test("功能关闭时跳过检测", async () => {
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("信任用户跳过检测", async () => {
    // trust_status = trusted
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("非文本消息跳过检测", async () => {
    // 无 text/caption
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("RiskLevel=high 被拦截", async () => {
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(true);
    expect(result.riskLevel).toBe("high");
  });

  test("RiskLevel=medium + Confidence >= 阈值被拦截", async () => {
    // medium + confidence=90, threshold=80
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(true);
  });

  test("RiskLevel=medium + Confidence < 阈值放行", async () => {
    // medium + confidence=70, threshold=80
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(false);
  });

  test("RiskLevel=low 放行", async () => {
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(false);
  });

  test("RiskLevel=none 放行", async () => {
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(false);
  });

  test("API 调用失败时 fail-open", async () => {
    const result = await checkGreenSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.error).toBe(true);
  });
});

describe("互斥控制", () => {
  test("开启Green时自动关闭AI", async () => {
    await setConfig("enable_aliyun_green", "true", env);
    const aiEnabled = await getBoolConfig("enable_ai_anti_harassment", env);
    expect(aiEnabled).toBe(false);
  });

  test("开启AI时自动关闭Green", async () => {
    await setConfig("enable_ai_anti_harassment", "true", env);
    const greenEnabled = await getBoolConfig("enable_aliyun_green", env);
    expect(greenEnabled).toBe(false);
  });

  test("两者不能同时开启", async () => {
    // 管理面板互斥校验
  });
});
```

### 8.2 集成测试

- 测试完整流程：消息 → 本地检测 → Green 检测 → 信任晋升 → 转发
- 测试 Green 不可用时的 fail-open 行为
- 测试 /trust /untrust 命令在 Green 模式下的操作
- 测试配置开关和互斥控制
- 测试 AI → Green 切换后信任列表不受影响
- 测试连通性检测功能

## 9. 部署影响

### 9.1 文件变更清单

**新增文件**：
- `src/security/aliyunGreen.js` - 阿里云 Green API 签名 + 调用
- `src/security/greenAntiHarassment.js` - Green 垃圾信息检测核心逻辑

**修改文件**：
- `src/handlers/private.js` - 将 TMS 分支替换为 Green 分支
- `src/handlers/adminConfig.js` - 新增 Green 配置面板 + 互斥逻辑，替换 TMS 入口
- `src/security/connectivityCheck.js` - 新增 Green 连通性检测
- `src/utils/constants.js` - 新增 Green 反骚扰默认配置

**保留但不启用**：
- `src/security/tencentTms.js` - 保留代码供参考
- `src/security/tmsAntiHarassment.js` - 保留代码供参考

**无需修改**：
- `src/database/index.js`（无需新建表，user_trust 已存在）
- `src/handlers/adminReply.js`（/trust /untrust 已实现，共享使用）
- `src/database/trust.js`（已支持自定义阈值参数）
- `src/database/users.js`
- `src/services/blacklist.js`

### 9.2 环境变量配置

```bash
# 通过 wrangler secret put 设置（不写入 wrangler.toml）
wrangler secret put ALIYUN_ACCESS_KEY_ID
wrangler secret put ALIYUN_ACCESS_KEY_SECRET

# 普通环境变量（可写入 wrangler.toml 或 Dashboard 设置）
ALIYUN_GREEN_REGION=ap-southeast-1
ALIYUN_GREEN_SERVICE=ugc_moderation_byllm_cb
ALIYUN_GREEN_TIMEOUT_MS=5000
```

### 9.3 配置迁移

首次部署时：
1. Green 反骚扰默认关闭（`enable_aliyun_green = false`）
2. 配置阿里云密钥后手动开启
3. 开启时自动关闭 AI 反骚扰
4. `user_trust` 表无需新增（已存在）
5. 腾讯 TMS 配置项保留但不再启用

### 9.4 回滚策略

- 关闭 `enable_aliyun_green` 配置即可完全回退到纯本地检测或 AI 检测
- 如需回退到腾讯 TMS，在 private.js 中恢复 TMS import 和分支即可
- 无需回滚代码，功能开关控制

## 10. 与腾讯 TMS 和 AI 反骚扰的对比

| 维度 | AI 反骚扰 | 腾讯 TMS 反骚扰 | 阿里云 Green 反骚扰 |
|------|----------|----------------|---------------------|
| 检测方式 | LLM API (OpenAI Compatible) | 腾讯 TMS API (TextModeration) | 阿里云 Green API (TextModerationPlus) |
| 响应速度 | 1-5 秒 | <100 毫秒 | 1-3 秒（大模型版） |
| 签名方式 | Bearer Token | TC3-HMAC-SHA256 | HMAC-SHA1 |
| 识别能力 | 语义理解，灵活 | 多维度覆盖，准确率高 | 大模型语义理解，支持119种语言 |
| 检测范围 | 广告/诈骗/钓鱼/辱骂/刷屏 | 色情/暴恐/违法/谩骂/广告/灌水/涉政 | 出海版：色情/暴恐/涉政/辱骂/赌博/种族主义/引流等 |
| 语言支持 | 取决于LLM | 中文为主 | 119种语言（出海版） |
| 境外支持 | 取决于LLM服务地域 | 不支持境外 | 新加坡地域，专为出海设计 |
| 成本 | LLM API 按 token 计费 | 套餐包计费 | 20元/万次（按量）/资源包 |
| 失败策略 | fail-open | fail-open | fail-open |
| 信任列表 | user_trust 表 | user_trust 表（共享） | user_trust 表（共享） |
| 互斥关系 | enable_ai_anti_harassment | enable_tencent_tms | enable_aliyun_green |
| 管理命令 | /trust /untrust | /trust /untrust（共享） | /trust /untrust（共享） |
| Workers兼容 | fetch API | fetch API + Web Crypto签名 | fetch API + Web Crypto签名 |
| 响应结构 | 文本判断（SPAM/CLEAN） | Suggestion+Label+Score | RiskLevel+Result(Label+Confidence) |
| 文本长度限制 | 512字符截断 | 10000字符 | 2000字符 |
| 拦截判定 | SPAM → 拦截 | Block→拦截, Review+Score≥阈值→拦截 | high→拦截, medium+Confidence≥阈值→拦截 |

**关键适配差异**：
1. **签名算法**：阿里云 HMAC-SHA1 比 腾讯 TC3-HMAC-SHA256 简单（1次 HMAC vs 4次 HMAC + 2次 SHA256）
2. **响应结构**：阿里云返回 RiskLevel + Result 数组（多标签），腾讯返回 Suggestion + 单 Label + Score
3. **拦截判定**：基于 RiskLevel 而非 Suggestion，medium 需要额外 Confidence 阈值判断
4. **文本长度**：阿里云 2000 字符（比腾讯 10000 短），需要截断策略调整
5. **地域选择**：新加坡（ap-southeast-1）而非国内地域
6. **多标签结果**：阿里云可能同时命中多个风险标签，管理员通知应列出所有命中标签

## 11. 签名实现对比

### 腾讯 TC3-HMAC-SHA256（4步签名）

```
1. CanonicalRequest = METHOD + URI + Query + Headers + SignedHeaders + HashedPayload
2. StringToSign = "TC3-HMAC-SHA256" + Timestamp + CredentialScope + Hash(CanonicalRequest)
3. Signature = HMAC(HMAC(HMAC(HMAC("TC3"+SecretKey, Date), Service), "tc3_request"), StringToSign)
4. Authorization = "TC3-HMAC-SHA256 Credential=... SignedHeaders=... Signature=..."
```

### 阿里云 HMAC-SHA1（简单签名）

```
1. CanonicalizedQueryString = sort(percentEncode(key)=percentEncode(value)&...)
2. StringToSign = "POST&percentEncode(/)&percentEncode(CanonicalizedQueryString)"
3. Signature = Base64(HMAC-SHA1(AccessKeySecret+"&", StringToSign))
4. 将 Signature 作为 QueryString 参数传递
```

阿里云签名显著更简单，实现和维护成本更低。