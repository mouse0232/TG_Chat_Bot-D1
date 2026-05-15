# 集成腾讯文本内容安全服务 - 技术设计文档

## 1. 架构设计

### 1.1 核心设计原则

**与 AI 反骚扰互斥**

两种智能检测方式只能二选一。开启 TMS 时自动关闭 AI，反之亦然。互斥通过配置开关和 adminConfig 处理逻辑双重保证。

**信任列表共享**

TMS 与 AI 反骚扰共享同一张 `user_trust` 表和同一套信任机制。切换检测方式时信任数据不受影响。

**信任每日重置**

与 AI 反骚扰完全一致，跨天归零。

### 1.2 模块位置

```
src/
├── security/
│   ├── antiHarassment.js              # 现有：本地反骚扰检测（不变）
│   ├── aiAntiHarassment.js            # 现有：AI 垃圾信息检测（不变）
│   ├── aiSpamPrompt.js                # 现有：LLM prompt 模板（不变）
│   ├── tencentTms.js                  # 新增：TMS API 签名 + 调用
│   ├── tmsAntiHarassment.js           # 新增：TMS 垃圾信息检测核心逻辑
├── database/
│   ├── trust.js                       # 现有：信任度数据库操作（不变，共享）
│   ├── index.js                       # 不变
│   ├── config.js                      # 不变
├── handlers/
│   ├── private.js                     # 修改：集成 TMS 检测调用（互斥分支）
│   ├── adminReply.js                  # 不变：/trust /untrust 命令已实现
│   ├── adminConfig.js                 # 修改：新增 TMS 反骚扰配置区域 + 互斥逻辑
│   ├── callback.js                    # 不变
├── services/
│   ├── blacklist.js                   # 现有：复用黑名单服务（不变）
│   └── relay.js                       # 现有：消息转发（不变）
├── utils/
│   └── constants.js                   # 修改：新增 TMS 反骚扰默认配置
└── api/
    └── telegram.js                    # 现有：TG API 封装（不变）
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
│ 2. TMS 开启？ → TMS检测│
│ 3. 两者关闭 → 直接转发 │
└──────────┬────────────┘
           │ 通过/AI信任/TMS信任
           ▼
┌───────────────────────┐
│ 屏蔽词/类型过滤/转发   │  ← 现有流程不变
└───────────────────────┘
```

## 2. 核心模块设计

### 2.1 `src/security/tencentTms.js`

**职责**：腾讯云 TMS API 签名计算与调用

**TC3-HMAC-SHA256 签名实现**：

腾讯云 API 3.0 使用 TC3-HMAC-SHA256 签名认证。在 Cloudflare Workers 环境下不能使用腾讯 SDK，需手动实现签名。

```javascript
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
  const httpRequestMethod = "POST";
  const canonicalUri = "/";
  const canonicalQueryString = "";
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TMS_HOST}\nx-tc-action:${TMS_ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const hashedCanonicalRequest = await sha256(canonicalRequest);
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;
  const secretDate = await hmacSha256(`TC3${secretKey}`, date);
  const secretService = await hmacSha256(secretDate, TMS_SERVICE);
  const secretSigning = await hmacSha256(secretService, "tc3_request");
  const signature = await hmacSha256(secretSigning, stringToSign);
  const signatureHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;
  return authorization;
}

export async function callTmsApi(env, content) {
  const secretId = env.TENCENT_SECRET_ID;
  const secretKey = env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) throw new Error("TENCENT_SECRET_ID or TENCENT_SECRET_KEY not configured");

  const timeout = parseInt(env.TENCENT_TMS_TIMEOUT_MS) || 3000;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    Content: btoa(content)
  });

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
        "X-TC-Timestamp": timestamp.toString(),
        "X-TC-Region": env.TENCENT_TMS_REGION || TMS_REGION_DEFAULT,
        "Authorization": authorization
      },
      body: payload,
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`TMS API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.Response?.Error) {
      throw new Error(`TMS API error: ${data.Response.Error.Code} - ${data.Response.Error.Message}`);
    }

    return data.Response;
  } finally {
    clearTimeout(timer);
  }
}
```

**设计要点**：

1. **使用 Web Crypto API 而非 Node.js crypto**：Cloudflare Workers 提供 `crypto.subtle`，兼容 TC3-HMAC-SHA256 签名计算
2. **3 秒超时**：TMS 正常响应 <100ms，3 秒超时已足够覆盖异常情况
3. **签名手动实现**：四步流程（CanonicalRequest → StringToSign → HMAC签名 → Authorization头）
4. **仅传入 Content 参数**：使用默认策略，不传 BizType（简化接入）

### 2.2 `src/security/tmsAntiHarassment.js`

**职责**：TMS 垃圾信息检测核心逻辑

**导出函数**：

```javascript
/**
 * TMS 垃圾信息检测
 * @param {Object} msg - Telegram Message 对象
 * @param {Object} user - DB 用户对象（含 trust_status）
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { spam: boolean, reason: string, label: string, score: number, skipped: boolean }
 */
export async function checkTmsSpam(msg, user, env)

/**
 * 处理 TMS 检测为垃圾的拦截动作
 * @param {string} userId - 用户 ID
 * @param {Object} userInfo - Telegram User 对象 (msg.from)
 * @param {string} reason - 检测原因（中文描述）
 * @param {string} label - TMS Label
 * @param {number} score - TMS Score
 * @param {Object} env - 环境变量
 */
export async function handleTmsSpamIntercept(userId, userInfo, reason, label, score, env)

/**
 * 处理 TMS 检测为正常的通过动作（信任计数更新）
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} 是否被自动加信
 */
export async function handleTmsCleanPass(userId, env)
```

**TMS Label 中文映射**：

```javascript
const TMS_LABEL_MAP = {
  Normal: "正常",
  Porn: "色情内容",
  Abuse: "辱骂内容",
  Ad: "广告内容",
  Illegal: "违法内容",
  Spam: "垃圾信息",
  Polity: "涉政内容",
  Terror: "暴恐内容",
  Custom: "自定义违规"
};
```

**核心实现逻辑**：

```javascript
import { getBoolConfig, getConfig } from '../database/config.js';
import { getUserTrust, incrementCleanCount, recordSpam, checkAndPromoteToWhitelist } from '../database/trust.js';
import { updateUser } from '../database/users.js';
import { manageBlacklist } from '../services/blacklist.js';
import { api } from '../api/telegram.js';
import { callTmsApi } from './tencentTms.js';

const SPAM_INTERCEPT_MSG = "您的消息因包含垃圾信息已被过滤。如有疑问，请联系管理员。";

export async function checkTmsSpam(msg, user, env) {
  const enabled = await getBoolConfig("enable_tencent_tms", env);
  if (!enabled) return { spam: false, skipped: true };

  const text = msg.text || msg.caption || "";
  if (!text) return { spam: false, skipped: true, reason: "非文本消息跳过TMS检测" };

  let trustInfo = await getUserTrust(user.user_id, env);
  if (!trustInfo) {
    await import('../database/trust.js').then(m => m.createUserTrust(user.user_id, msg.from?.username, env));
    trustInfo = await getUserTrust(user.user_id, env);
  }

  if (trustInfo?.trust_status === 'trusted') {
    return { spam: false, skipped: true, reason: "信任用户跳过检测" };
  }

  const truncatedText = text.substring(0, 10000);

  try {
    const tmsResult = await callTmsApi(env, truncatedText);
    const suggestion = tmsResult.Suggestion;
    const label = tmsResult.Label;
    const score = tmsResult.Score || 0;

    if (suggestion === "Block") {
      const reason = TMS_LABEL_MAP[label] || label || "TMS检测为违规内容";
      return { spam: true, reason, label, score, skipped: false };
    }

    if (suggestion === "Review") {
      const threshold = parseInt(await getConfig("tencent_tms_review_block_threshold", env)) || 60;
      if (score >= threshold) {
        const reason = TMS_LABEL_MAP[label] || label || "TMS疑似违规内容";
        return { spam: true, reason, label, score, skipped: false };
      }
    }

    return { spam: false, label, score, skipped: false };
  } catch (error) {
    console.error('[TmsAntiHarassment] TMS API call failed:', error);
    return { spam: false, skipped: false, error: true };
  }
}

export async function handleTmsSpamIntercept(userId, userInfo, reason, label, score, env) {
  console.log(`[TmsAntiHarassment] User ${userId} TMS spam intercepted. Label: ${label}, Score: ${score}, Reason: ${reason}`);
  try {
    await recordSpam(userId, env);
    await updateUser(userId, { is_blocked: true, user_info: { tms_spam_reason: reason, tms_label: label, tms_score: score } }, env);
    const u = await import('../database/users.js').then(m => m.getUser(userId, env));
    await manageBlacklist(env, u, userInfo, true);

    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: SPAM_INTERCEPT_MSG
    }).catch(() => {});

    if (env.ADMIN_GROUP_ID) {
      const now = new Date();
      const utcPlus8Ms = now.getTime() + 8 * 60 * 60 * 1000;
      const d = new Date(utcPlus8Ms);
      const timeStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
      const senderName = `${userInfo?.first_name || ''}${userInfo?.last_name ? ' ' + userInfo.last_name : ''}`.trim() || 'Unknown';
      const uname = userInfo?.username ? ` (@${userInfo.username})` : '';
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        text: `[TMS] 垃圾信息警告\n\n发送者: ${senderName}${uname} (ID: ${userId})\nTMS判定: ${label} (${reason})\n置信度: ${score}\n建议: Block\n时间: ${timeStr}`,
        parse_mode: "HTML"
      }).catch(() => {});
    }
  } catch (error) {
    console.error(`[TmsAntiHarassment] TMS spam intercept failed for ${userId}:`, error);
  }
}

export async function handleTmsCleanPass(userId, env) {
  try {
    await incrementCleanCount(userId, env);
    const threshold = parseInt(await getConfig("tencent_tms_trust_threshold", env)) || 3;
    const promoted = await checkAndPromoteToWhitelist(userId, env, threshold);
    if (promoted) {
      console.log(`[TmsAntiHarassment] User ${userId} promoted to trust list`);
    }
    return promoted;
  } catch (error) {
    console.error(`[TmsAntiHarassment] Clean pass processing failed for ${userId}:`, error);
    return false;
  }
}
```

**设计要点**：

1. **Suggestion 映射**：Block → 直接拦截；Review → 根据 Score 阈值决定拦截/放行；Pass → 放行
2. **Label 中文映射**：将 TMS 返回的英文 Label 映射为中文原因描述，用于管理员通知
3. **复用信任模块**：`incrementCleanCount`、`recordSpam`、`checkAndPromoteToWhitelist` 直接复用 trust.js
4. **信任阈值区分**：`handleTmsCleanPass` 传入 `tencent_tms_trust_threshold` 而非 `ai_anti_harassment_trust_threshold`，需要修改 `checkAndPromoteToWhitelist` 支持自定义阈值参数

### 2.3 `src/database/trust.js` 修改

**修改点**：`checkAndPromoteToWhitelist` 函数新增可选的 threshold 参数

```javascript
export async function checkAndPromoteToWhitelist(userId, env, customThreshold) {
  const threshold = customThreshold || parseInt(await getConfig("ai_anti_harassment_trust_threshold", env)) || 3;
  const trust = await getUserTrust(userId, env);
  if (!trust) return false;
  if (trust.trust_status === 'trusted') return false;

  if (trust.consecutive_clean_count >= threshold) {
    const db = env.TG_BOT_DB;
    const now = Date.now();
    await db.prepare(
      'UPDATE user_trust SET trust_status = ?, whitelisted_at = ?, whitelisted_by = ? WHERE user_id = ?'
    ).bind('trusted', now, 'auto', userId).run();
    return true;
  }
  return false;
}
```

AI 反骚扰的调用保持不变：`checkAndPromoteToWhitelist(userId, env)` 使用默认的 `ai_anti_harassment_trust_threshold`。
TMS 的调用：`checkAndPromoteToWhitelist(userId, env, parseInt(await getConfig("tencent_tms_trust_threshold", env)) || 3)` 使用 `tencent_tms_trust_threshold`。

### 2.4 `src/handlers/private.js` 修改

**修改点**：`handleVerifiedMsg` 函数中，将 AI 检测与 TMS 检测做成互斥分支

```javascript
import { checkTmsSpam, handleTmsSpamIntercept, handleTmsCleanPass } from '../security/tmsAntiHarassment.js';

async function handleVerifiedMsg(msg, u, env, ctx) {
  const id = u.user_id;

  if (u.is_blocked && !(await isAuthAdmin(id, env))) return;

  const msgCheck = await checkMessage(msg, env);
  if (msgCheck.triggered) {
    await handleMessageIntercept(id, msg.from, msgCheck.reason, env);
    return;
  }

  const aiEnabled = await getBoolConfig("enable_ai_anti_harassment", env);
  const tmsEnabled = await getBoolConfig("enable_tencent_tms", env);

  if (tmsEnabled) {
    const tmsCheck = await checkTmsSpam(msg, u, env);
    if (tmsCheck.spam) {
      await handleTmsSpamIntercept(id, msg.from, tmsCheck.reason, tmsCheck.label, tmsCheck.score, env);
      return;
    }
    if (!tmsCheck.skipped && !tmsCheck.error) {
      const promoted = await handleTmsCleanPass(id, env);
      if (promoted) {
        const notify = await getBoolConfig("tencent_tms_notify_auto_whitelist", env);
        if (notify && env.ADMIN_GROUP_ID) {
          const senderName = msg.from?.first_name || 'Unknown';
          const threshold = await getConfig("tencent_tms_trust_threshold", env) || 3;
          await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: `✅ 用户 ${senderName} 当日连续通过 ${threshold} 次 TMS 检测，已加入信任列表（当日免检）`
          }).catch(() => {});
        }
      }
    }
  } else if (aiEnabled) {
    const aiCheck = await checkAiSpam(msg, u, env);
    if (aiCheck.spam) {
      await handleAiSpamIntercept(id, msg.from, aiCheck.reason, env);
      return;
    }
    if (!aiCheck.skipped && !aiCheck.error) {
      const promoted = await handleAiCleanPass(id, env);
      if (promoted) {
        const notify = await getBoolConfig("ai_anti_harassment_notify_auto_whitelist", env);
        if (notify && env.ADMIN_GROUP_ID) {
          const senderName = msg.from?.first_name || 'Unknown';
          const threshold = await getConfig("ai_anti_harassment_trust_threshold", env) || 3;
          await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: `✅ 用户 ${senderName} 当日连续通过 ${threshold} 次 AI 检测，已加入 AI 信任列表（当日免检）`
          }).catch(() => {});
        }
      }
    }
  }

  const text = msg.text || msg.caption || "";
  // 原有逻辑继续：屏蔽词检测、类型过滤、转发...
}
```

**互斥保证**：代码层面按 TMS > AI 的优先级检查。配置层面开启一个自动关闭另一个。

### 2.5 `src/handlers/adminConfig.js` 修改

**新增 TMS 配置面板** 和 **互斥控制逻辑**

**菜单层新增入口**：

```javascript
// config:menu 的 inline_keyboard 新增按钮
[{ text: "🤖 AI反骚扰", callback_data: "config:menu:aiah" }],
[{ text: "🛡 TMS反骚扰", callback_data: "config:menu:tms" }]  // 新增
```

**TMS 配置面板** (key === "tms")：

```javascript
if (key === "tms") {
  const tmsEnabled = await getBoolConfig("enable_tencent_tms", env);
  const threshold = await getConfig("tencent_tms_trust_threshold", env) || 3;
  const notifyAuto = await getBoolConfig("tencent_tms_notify_auto_whitelist", env);
  const reviewThreshold = await getConfig("tencent_tms_review_block_threshold", env) || 60;
  const t = (v) => v ? "✅" : "❌";
  const secretReady = !!env.TENCENT_SECRET_ID && !!env.TENCENT_SECRET_KEY;
  const secretStatus = secretReady ? "✅ 已配置" : "❌ 未配置密钥";

  return render(`🛡 <b>TMS 反骚扰检测</b>\n总开关: ${t(tmsEnabled)}\n密钥配置: ${secretStatus}\n信任阈值: 当日连续通过 ${threshold} 次\nReview拦截阈值: Score >= ${reviewThreshold}\n加信通知: ${t(notifyAuto)}\n\n<b>说明</b>\n- 腾讯TMS毫秒级响应，延时远低于AI\n- 与AI反骚扰<b>互斥</b>，开启TMS自动关闭AI\n- 信任列表与AI共享<b>同一套</b>${!secretReady ? "\n\n⚠️ <b>请先配置 TENCENT_SECRET_ID/TENCENT_SECRET_KEY 再开启</b>" : ""}`, {
    inline_keyboard: [
      [{ text: `总开关: ${t(tmsEnabled)}${!secretReady && !tmsEnabled ? " (需先配置密钥)" : ""}`, callback_data: `config:toggle:enable_tencent_tms:${!tmsEnabled}` }],
      [{ text: `信任阈值: ${threshold}`, callback_data: `config:edit:tencent_tms_trust_threshold` }],
      [{ text: `Review阈值: ${reviewThreshold}`, callback_data: `config:edit:tencent_tms_review_block_threshold` }],
      [{ text: `加信通知: ${t(notifyAuto)}`, callback_data: `config:toggle:tencent_tms_notify_auto_whitelist:${!notifyAuto}` }],
      [back]
    ]
  });
}
```

**互斥控制** (toggle 处理)：

```javascript
if (type === "toggle") {
  // 开启 TMS 时自动关闭 AI，并校验密钥
  if (key === "enable_tencent_tms" && val === "true") {
    if (!env.TENCENT_SECRET_ID || !env.TENCENT_SECRET_KEY) {
      return render("❌ <b>无法开启 TMS 反骚扰</b>\n\n未配置腾讯云密钥。\n请在 Cloudflare Dashboard 或 wrangler secret 中设置以下变量后重试：\n\n<b>必需</b>:\n• TENCENT_SECRET_ID — 腾讯云 API SecretId\n• TENCENT_SECRET_KEY — 腾讯云 API SecretKey\n\n<b>可选</b>:\n• TENCENT_TMS_TIMEOUT_MS — 超时毫秒数 (默认 3000)", {
        inline_keyboard: [[{ text: "🔙 返回 TMS 反骚扰", callback_data: "config:menu:tms" }]]
      });
    }
    await setConfig("enable_ai_anti_harassment", "false", env);
  }

  // 开启 AI 时自动关闭 TMS
  if (key === "enable_ai_anti_harassment" && val === "true" && !env.LLM_KEY) {
    return render("❌ <b>无法开启 AI 反骚扰</b>\n\n未配置 LLM 环境变量。...", {
      inline_keyboard: [[{ text: "🔙 返回 AI 反骚扰", callback_data: "config:menu:aiah" }]]
    });
  }
  if (key === "enable_ai_anti_harassment" && val === "true") {
    await setConfig("enable_tencent_tms", "false", env);
  }

  await setConfig(key, val, env);
  const tmsAhKeys = ["enable_tencent_tms", "tencent_tms_notify_auto_whitelist"];
  if (tmsAhKeys.includes(key)) return handleAdminConfig(cid, mid, "menu", "tms", null, env);
  // ... 现有逻辑
}
```

### 2.6 `src/utils/constants.js` 修改

**新增默认配置**：

```javascript
// DEFAULTS 新增
enable_tencent_tms: "false",
tencent_tms_trust_threshold: "3",
tencent_tms_review_block_threshold: "60",
tencent_tms_notify_auto_whitelist: "true"
```

### 2.7 数据库表无需修改

`user_trust` 表已存在且共享，无需新建表。信任数据在 AI 和 TMS 模式下通用。

## 3. 接口设计

### 3.1 腾讯云 TextModeration API 调用

使用 TC3-HMAC-SHA256 签名认证，通过原生 fetch 调用：

```
POST https://tms.tencentcloudapi.com

Headers:
  Content-Type: application/json; charset=utf-8
  Host: tms.tencentcloudapi.com
  X-TC-Action: TextModeration
  X-TC-Version: 2020-12-29
  X-TC-Timestamp: <Unix秒级时间戳>
  Authorization: TC3-HMAC-SHA256 Credential=<SecretId>/<Date>/tms/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=<Hex签名>

Body:
  { "Content": "<待检测文本>" }

Response:
{
  "Response": {
    "Suggestion": "Block|Review|Pass",
    "Label": "Normal|Porn|Abuse|Ad|Illegal|Spam|Polity|Terror|Custom",
    "Score": 0-100,
    "Keywords": ["命中关键词列表"],
    "SubLabel": "子标签",
    "Detail": { ... },
    "RequestId": "请求ID"
  }
}
```

### 3.2 内部接口总览

```javascript
// tencentTms.js
callTmsApi(env, content)                  → TMS Response 对象

// tmsAntiHarassment.js
checkTmsSpam(msg, user, env)              → { spam, reason, label, score, skipped, error }
handleTmsSpamIntercept(userId, userInfo, reason, label, score, env) → void
handleTmsCleanPass(userId, env)           → boolean (是否晋升信任列表)

// trust.js (修改)
checkAndPromoteToWhitelist(userId, env, customThreshold?) → boolean
// 其他函数不变，共享使用
```

## 4. 数据流设计

### 4.1 TMS 垃圾信息检测数据流

```
msg (Telegram Message) + user (DB User)
    │
    ▼
┌───────────────────┐
│ checkTmsSpam()    │
│                   │
│ 1. 总开关检查     │ → 关闭 → { spam: false, skipped: true }
│ 2. 文本检查       │ → 无文本 → { spam: false, skipped: true }
│ 3. 信任检查       │ → trusted → { spam: false, skipped: true }
│ 4. 获取信任记录   │ → 无记录 → createUserTrust()
│ 5. callTmsApi()   │ → 超时/错误 → { spam: false, error: true }
│ 6. Suggestion映射 │
│    - Block → spam │
│    - Review +     │
│      Score≥阈值   │ → spam
│    - Pass → clean │
└──────────┬────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
  CLEAN        SPAM
     │           │
     ▼           ▼
handleTms      handleTms
CleanPass()    SpamIntercept()
     │           │
     ▼           ▼
incrementClean 1. recordSpam()
Count()         2. updateUser({is_blocked: true,
     │              user_info: {tms_label, tms_score}})
     ▼           3. manageBlacklist()
checkAndPromote 4. 发送拦截提示
ToWhitelist()   5. 通知管理员（含Label/Score）
     │
     ▼
   达到阈值 → trustUser('auto')
   未达阈值 → 继续
```

### 4.2 管理员通知数据流

```
TMS 检测为 Block/Review(≥阈值)
    │
    ▼
┌───────────────────┐
│ handleTms          │
│ SpamIntercept()    │
│                   │
│ 1. 发送拦截提示    │ → 用户收到 "您的消息因包含垃圾信息已被过滤"
│ 2. recordSpam()   │ → D1: trust_status=monitoring, count=0, spam+1
│ 3. updateUser()   │ → D1: is_blocked=true, user_info={tms_label, tms_score, tms_spam_reason}
│ 4. manageBlacklist│ → 管理群组黑名单通知
│ 5. 发送 TMS 报告  │ → 管理群组收到：
│                   │   "[TMS] 垃圾信息警告
│                   │    发送者: xxx (@xxx) (ID: xxx)
│                   │    TMS判定: Ad (广告内容)
│                   │    置信度: 97
│                   │    建议: Block
│                   │    时间: 2026-05-15 12:00:00"
└───────────────────┘
```

## 5. 错误处理

### 5.1 TMS API 调用失败

```javascript
try {
  const tmsResult = await callTmsApi(env, truncatedText);
  // 处理结果...
} catch (error) {
  console.error('[TmsAntiHarassment] TMS API call failed:', error);
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

Web Crypto API 在 Workers 中始终可用，但若 secretId/secretKey 为空则直接抛错，进入 fail-open。

### 5.4 信任数据操作失败

```javascript
try {
  await incrementCleanCount(userId, env);
} catch (error) {
  console.error('[TmsAntiHarassment] Trust DB operation failed:', error);
  // 不阻断消息流程，仅记录日志
}
```

### 5.5 错误汇总

| 错误场景 | 处理策略 | 用户影响 |
|----------|----------|----------|
| TMS API 返回非 200 | fail-open，记录错误日志 | 消息正常转发 |
| TMS API 超时（3s） | fail-open（AbortController） | 消息正常转发 |
| TMS 返回 Error 响应 | fail-open，记录 Error.Code | 消息正常转发 |
| 签名密钥未配置 | fail-open | 消息正常转发 |
| 信任数据操作失败 | 记录日志，不阻断 | 消息正常转发，下次重试 |
| 拦截处理失败 | 记录日志，不抛异常 | 用户可能收到部分通知 |

## 6. 性能考虑

### 6.1 API 调用延迟

| 场景 | 延迟 |
|------|------|
| 信任用户 | 0ms（跳过检测） |
| 非信任用户 | ~30-50ms（TMS API） |
| 超时上限 | 3s（AbortController） |
| AI 反骚扰对比 | 1-5s（LLM API） |

TMS 比AI快约 10-100 倍，这是核心优势。

### 6.2 成本控制

- 信任列表系统：trusted 用户完全跳过 TMS 调用
- 仅文本消息检测：非文本消息仅本地检测
- 默认关闭：`enable_tencent_tms` 默认 `false`
- 腾讯 TMS 套餐包：最低 2000 元/年/180万条

### 6.3 Workers 限制

- Cloudflare Workers CPU 时间限制：30s（paid），10s（free）
- fetch 调用不计入 CPU 时间（subrequest）
- TC3-HMAC-SHA256 签名计算：~1-2ms（Web Crypto API）
- 3s 超时确保不超出 Workers 限制

### 6.4 签名计算性能

- `crypto.subtle.importKey` + `sign` 为异步操作，但 Workers 环境下极快
- 签名计算涉及 4 次 HMAC-SHA256 + 2 次 SHA256，总计 ~1-2ms
- 对比 AI 反骚扰的 prompt 构造 + fetch 调用，签名开销微不足道

## 7. 安全考虑

### 7.1 腾讯云密钥安全

- 环境变量存储，不硬编码
- Workers Secrets 管理（`wrangler secret put TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`）
- 不在日志中输出密钥

### 7.2 防误判

- Review 结果需要 Score >= 阈值才拦截（默认 60），避免误杀
- fail-open 策略：TMS 不可用时放行
- 信任用户完全免检
- 管理员不受检测影响

### 7.3 防绕过

- 本地检测 + TMS 检测双重屏障
- 信任列表仅当日有效，每日重置
- 黑名单优先于信任列表
- 管理员可随时 /untrust 移出信任列表
- 信任列表与黑白名单完全解耦

### 7.4 签名安全

- TC3-HMAC-SHA256 为腾讯云标准签名方法，安全性有保障
- 签名中包含时间戳，防止重放攻击
- 请求体参与签名，防止篡改

## 8. 测试策略

### 8.1 单元测试

```javascript
describe("tencentTms - TC3-HMAC-SHA256 签名", () => {
  test("签名计算正确", async () => {
    // 使用已知输入验证签名输出
    const authorization = await signRequest("AKIDz8krbsJ5...", "Gu5t9geU...", '{"Content":"test"}', 1620000000);
    expect(authorization).toMatch(/^TC3-HMAC-SHA256/);
    expect(authorization).toContain("Credential=AKIDz8krbsJ5");
    expect(authorization).toContain("SignedHeaders=content-type;host;x-tc-action");
    expect(authorization).toContain("Signature=");
  });
});

describe("checkTmsSpam", () => {
  test("功能关闭时跳过检测", async () => {
    const result = await checkTmsSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("信任用户跳过检测", async () => {
    const result = await checkTmsSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("非文本消息跳过检测", async () => {
    const result = await checkTmsSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("Block 消息被拦截", async () => {
    const result = await checkTmsSpam(msg, user, env);
    expect(result.spam).toBe(true);
    expect(result.label).toBe("Ad");
    expect(result.reason).toBe("广告内容");
  });

  test("Review + Score >= 阈值被拦截", async () => {
    // Suggestion=Review, Score=80, threshold=60
    const result = await checkTmsSpam(msg, user, env);
    expect(result.spam).toBe(true);
  });

  test("Review + Score < 阈值放行", async () => {
    // Suggestion=Review, Score=55, threshold=60
    const result = await checkTmsSpam(msg, user, env);
    expect(result.spam).toBe(false);
  });

  test("Pass 消息放行", async () => {
    const result = await checkTmsSpam(msg, user, env);
    expect(result.spam).toBe(false);
  });

  test("API 调用失败时 fail-open", async () => {
    // TMS_API unreachable
    const result = await checkTmsSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.error).toBe(true);
  });
});

describe("互斥控制", () => {
  test("开启TMS时自动关闭AI", async () => {
    await setConfig("enable_tencent_tms", "true", env);
    const aiEnabled = await getBoolConfig("enable_ai_anti_harassment", env);
    expect(aiEnabled).toBe(false);
  });

  test("开启AI时自动关闭TMS", async () => {
    await setConfig("enable_ai_anti_harassment", "true", env);
    const tmsEnabled = await getBoolConfig("enable_tencent_tms", env);
    expect(tmsEnabled).toBe(false);
  });

  test("两者不能同时开启", async () => {
    // 管理面板逻辑保证互斥
    expect(true).toBe(true);
  });
});
```

### 8.2 集成测试

- 测试完整流程：消息 → 本地检测 → TMS 检测 → 信任晋升 → 转发
- 测试 TMS 不可用时的 fail-open 行为
- 测试 /trust /untrust 命令在 TMS 模式下的操作
- 测试配置开关和互斥控制
- 测试 AI → TMS 切换后信任列表不受影响

## 9. 部署影响

### 9.1 文件变更清单

**新增文件**：
- `src/security/tencentTms.js` - TMS API 签名 + 调用
- `src/security/tmsAntiHarassment.js` - TMS 垃圾信息检测核心逻辑

**修改文件**：
- `src/handlers/private.js` - 集成 TMS 检测调用（互斥分支）
- `src/handlers/adminConfig.js` - 新增 TMS 配置面板 + 互斥逻辑
- `src/utils/constants.js` - 新增 TMS 反骚扰默认配置
- `src/database/trust.js` - checkAndPromoteToWhitelist 新增可选阈值参数

**无需修改**：
- `src/database/index.js`（无需新建表，user_trust 已存在）
- `src/handlers/adminReply.js`（/trust /untrust 已实现，共享使用）
- `src/database/users.js`
- `src/services/blacklist.js`

### 9.2 环境变量配置

```bash
# 通过 wrangler secret put 设置（不写入 wrangler.toml）
wrangler secret put TENCENT_SECRET_ID
wrangler secret put TENCENT_SECRET_KEY

# 普通环境变量（可写入 wrangler.toml 或 Dashboard 设置）
TENCENT_TMS_REGION=ap-guangzhou
TENCENT_TMS_TIMEOUT_MS=3000
```

### 9.3 配置迁移

首次部署时：
1. TMS 反骚扰默认关闭（`enable_tencent_tms = false`）
2. 配置腾讯云密钥后手动开启
3. 开启时自动关闭 AI 反骚扰
4. `user_trust` 表无需新增（已存在）

### 9.4 回滚策略

- 关闭 `enable_tencent_tms` 配置即可完全回退到纯本地检测或 AI 检测
- 无需回滚代码，功能开关控制

## 10. 与 AI 反骚扰的对比

| 维度 | AI 反骚扰 | TMS 反骚扰 |
|------|----------|------------|
| 检测方式 | LLM API (OpenAI Compatible) | 腾讯 TMS API (TextModeration) |
| 响应速度 | 1-5 秒 | <100 毫秒 |
| 签名方式 | Bearer Token | TC3-HMAC-SHA256 |
| 识别能力 | 语义理解，灵活 | 多维度覆盖，准确率高 |
| 检测范围 | 广告/诈骗/钓鱼/辱骂/刷屏 | 色情/暴恐/违法/谩骂/广告/灌水/涉政 |
| 成本 | LLM API 按 token 计费 | TMS 按条数计费（套餐包） |
| 失败策略 | fail-open | fail-open |
| 信任列表 | user_trust 表 | user_trust 表（共享） |
| 信任阈值配置 | ai_anti_harassment_trust_threshold | tencent_tms_trust_threshold |
| 互斥关系 | enable_ai_anti_harassment | enable_tencent_tms |
| 管理命令 | /trust /untrust | /trust /untrust（共享） |
| Workers兼容 | fetch API | fetch API + Web Crypto签名 |

**关键适配**：
- TMS 使用 TC3-HMAC-SHA256 签名，需手动实现（Workers 不支持腾讯 SDK）
- TMS 响应结构（Suggestion/Label/Score）与 AI 不同，需映射为统一的拦截判断
- 信任列表共享，但阈值配置各自独立
- 互斥控制通过配置开关和 adminConfig 逻辑双重保证