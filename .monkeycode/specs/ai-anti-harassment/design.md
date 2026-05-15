# 集成 AI 反骚扰功能 - 技术设计文档

## 1. 架构设计

### 1.1 核心设计原则

**AI 信任列表与黑白名单完全解耦**

| 维度 | 存储位置 | 控制范围 | 说明 |
|------|----------|----------|------|
| 黑名单 | `users.is_blocked` | 消息是否放行 | 项目原有封禁机制 |
| AI 信任列表 | `user_trust.trust_status` | 是否跳过 AI 检测 | 仅控制 LLM API 调用，不影响消息放行 |

两者不发生任何关系，流程上黑名单检查在 AI 检测之前，天然不冲突。

**信任每日重置**

AI 信任基于当日连续行为，第二天归零重新计算。这样拉黑/解封与 AI 信任完全无关。

### 1.2 模块位置

```
src/
├── security/
│   ├── antiHarassment.js              # 现有：本地反骚扰检测（不变）
│   └── aiAntiHarassment.js            # 新增：AI 垃圾信息检测核心逻辑
│   └── aiSpamPrompt.js                # 新增：LLM prompt 模板
├── database/
│   ├── trust.js                       # 新增：用户信任度数据库操作
│   ├── index.js                       # 修改：新增 user_trust 表初始化
│   └── config.js                      # 修改（可能）：信任配置读取
├── handlers/
│   ├── private.js                     # 修改：集成 AI 检测调用
│   ├── adminReply.js                  # 修改：新增 /trust /untrust 命令
│   ├── callback.js                    # 修改：新增信任管理回调按钮
│   └── adminConfig.js                 # 修改：新增 AI 反骚扰配置区域
├── services/
│   └── blacklist.js                   # 现有：复用黑名单服务（不变）
│   └── relay.js                       # 现有：消息转发（不变）
├── utils/
│   └── constants.js                   # 修改：新增 AI 反骚扰默认配置 + prompt
└── api/
    └── telegram.js                    # 现有：TG API 封装（不变）
```

### 1.2 检测流程集成点

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
│ AI 反骚扰检测          │  ← 第二层：AI 语义检测
│ (aiAntiHarassment.js) │
│                       │
│ 1. 总开关检查          │
│ 2. 每日重置检查        │ ← 跨天则归零 trust_status/计数
│ 3. AI信任列表检查      │ ← trusted 免检（仅当日）
│ 4. 仅文本消息检测      │
│ 5. LLM API 调用       │
│ 6. 结果处理           │
└──────────┬────────────┘
           │ 通过/AI信任
           ▼
┌───────────────────────┐
│ 屏蔽词/类型过滤/转发   │  ← 现有流程不变
└───────────────────────┘
```

## 2. 核心模块设计

### 2.1 `src/security/aiSpamPrompt.js`

**职责**：LLM 提示词模板定义

```javascript
export const SPAM_SYSTEM_PROMPT = `你是一个专业的垃圾信息检测助手。你的任务是判断 Telegram 消息是否为垃圾信息。

垃圾信息包括但不限于：
1. 商业广告和营销信息
2. 诈骗、钓鱼信息
3. 恶意链接或病毒传播
4. 骚扰、辱骂、不当内容
5. 重复刷屏的无意义消息
6. 未经允许的推广信息

判断标准：
- 考虑发送者的姓名和消息内容
- 注意识别伪装的广告（如使用表情符号、特殊字符）
- 识别常见的诈骗话术和模式
- 注意多语言的垃圾信息

回复格式：
- 如果是垃圾信息，请以 "SPAM:" 开头，后面简要说明理由（50字以内）
- 如果不是垃圾信息，只回复 "CLEAN"

注意：
- 保持严格的判断标准，避免误判
- 当不确定时，倾向于判定为 CLEAN`;

export const SPAM_USER_PROMPT_TEMPLATE = `请判断以下消息是否为垃圾信息：

发送者姓名: {{senderName}}
消息内容：{{messageText}}`;

export function fillPromptTemplate(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
  }
  return result;
}
```

### 2.2 `src/security/aiAntiHarassment.js`

**职责**：AI 垃圾信息检测核心逻辑

**导出函数**：

```javascript
/**
 * AI 垃圾信息检测
 * @param {Object} msg - Telegram Message 对象
 * @param {Object} user - DB 用户对象（含 trust_status）
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { spam: boolean, reason: string, skipped: boolean }
 */
export async function checkAiSpam(msg, user, env)

/**
 * 处理 AI 检测为垃圾的拦截动作
 * @param {string} userId - 用户 ID
 * @param {Object} userInfo - Telegram User 对象 (msg.from)
 * @param {string} reason - AI 检测原因
 * @param {Object} env - 环境变量
 */
export async function handleAiSpamIntercept(userId, userInfo, reason, env)

/**
 * 处理 AI 检测为正常的通过动作（信任计数更新）
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} 是否被自动加白
 */
export async function handleAiCleanPass(userId, env)
```

**核心实现逻辑**：

```javascript
import { getBoolConfig, getConfig } from '../database/config.js';
import { getUserTrust, incrementCleanCount, recordSpam, checkAndPromoteToWhitelist } from '../database/trust.js';
import { updateUser } from '../database/users.js';
import { manageBlacklist } from '../services/blacklist.js';
import { api } from '../api/telegram.js';
import { SPAM_SYSTEM_PROMPT, SPAM_USER_PROMPT_TEMPLATE, fillPromptTemplate } from './aiSpamPrompt.js';

const SPAM_INTERCEPT_MSG = "您的消息因包含垃圾信息已被过滤。如有疑问，请联系管理员。";

export async function checkAiSpam(msg, user, env) {
  const enabled = await getBoolConfig("enable_ai_anti_harassment", env);
  if (!enabled) return { spam: false, skipped: true };

  const text = msg.text || msg.caption || "";
  if (!text) return { spam: false, skipped: true, reason: "非文本消息跳过AI检测" };

  const trustInfo = await getUserTrust(user.user_id, env);
  // AI 信任列表用户跳过检测（仅当日有效，每日重置在 incrementCleanCount 中处理）
  if (trustInfo?.trust_status === 'trusted') {
    return { spam: false, skipped: true, reason: "AI信任用户跳过检测" };
  }

  const senderName = `${msg.from?.first_name || ''}${msg.from?.last_name ? ' ' + msg.from.last_name : ''}`.trim() || 'Unknown';
  const userPrompt = fillPromptTemplate(SPAM_USER_PROMPT_TEMPLATE, { senderName, messageText: text });

  try {
    const judgment = await callLlmApi(env, SPAM_SYSTEM_PROMPT, userPrompt);
    if (judgment.startsWith('SPAM')) {
      const reason = judgment.replace(/^SPAM:\s*/, '').trim() || 'AI检测为垃圾信息';
      return { spam: true, reason, skipped: false };
    }
    return { spam: false, skipped: false };
  } catch (error) {
    console.error('[AiAntiHarassment] LLM API call failed:', error);
    return { spam: false, skipped: false, error: true };
  }
}

async function callLlmApi(env, systemPrompt, userPrompt) {
  const baseUrl = env.LLM_API || 'https://api.openai.com/v1';
  const timeout = parseInt(env.LLM_TIMEOUT_MS) || 5000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.LLM_KEY}`
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`LLM API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM API returned empty response');
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}
```

**设计要点**：

1. **使用 fetch API 而非 OpenAI SDK**：Cloudflare Workers 不支持 Node.js 模块，直接使用原生 `fetch` 调用 OpenAI Compatible API
2. **AbortController 超时控制**：5 秒超时，超时后 fail-open
3. **仅检测文本消息**：`msg.text` 或 `msg.caption` 为空时跳过 AI 检测
4. **AI 信任列表快速跳过**：trusted 用户不调用 API，降低成本（仅当日有效）
5. **每日重置**：跨天消息自动归零信任计数和状态

### 2.3 `src/database/trust.js`

**职责**：用户信任度数据库操作

```javascript
/**
 * 获取用户信任信息
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<Object|null>} trust info
 */
export async function getUserTrust(userId, env)

/**
 * 创建用户信任记录（首次发消息时）
 * @param {string} userId - 用户 ID
 * @param {string} username - Telegram 用户名
 * @param {Object} env - 环境变量
 */
export async function createUserTrust(userId, username, env)

/**
 * 增加连续通过次数
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 */
export async function incrementCleanCount(userId, env)

/**
 * 记录垃圾消息（重置连续通过次数，增加垃圾计数）
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 */
export async function recordSpam(userId, env)

/**
 * 检查并晋升为白名单
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} 是否晋升成功
 */
export async function checkAndPromoteToWhitelist(userId, env)

/**
 * 手动信任用户
 * @param {string} userId - 用户 ID
 * @param {string} by - 操作来源 ('admin')
 * @param {Object} env - 环境变量
 */
export async function trustUser(userId, by, env)

/**
 * 取消信任用户
 * @param {string} userId - 用户 ID
 * @param {Object} env - 环境变量
 */
export async function untrustUser(userId, env)
```

**数据库表结构**：

```sql
CREATE TABLE IF NOT EXISTS user_trust (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  trust_status TEXT DEFAULT 'new',
  consecutive_clean_count INTEGER DEFAULT 0,
  last_clean_date TEXT,       -- 当日计数的日期标识（YYYY-MM-DD格式），用于跨天检测
  total_spam_count INTEGER DEFAULT 0,
  whitelisted_at INTEGER,
  whitelisted_by TEXT,
  last_message_at INTEGER,
  created_at INTEGER
);
```

**新增字段说明**：

`last_clean_date`：记录 `consecutive_clean_count` 所属的日期（UTC+8，YYYY-MM-DD 格式）。每次 `incrementCleanCount` 时检查当前日期是否与 `last_clean_date` 一致：
- 一致 → 计数 +1
- 不一致（跨天） → 计数归零重计，`trust_status` 回到 `new`，`last_clean_date` 更新为新日期

**核心实现**：

```javascript
import { getConfig } from './config.js';

function getTodayDateStr() {
  const now = new Date();
  const utcPlus8Ms = now.getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(utcPlus8Ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function getUserTrust(userId, env) {
  const db = env.TG_BOT_DB;
  const result = await db.prepare('SELECT * FROM user_trust WHERE user_id = ?').bind(userId).first();
  return result;
}

export async function createUserTrust(userId, username, env) {
  const db = env.TG_BOT_DB;
  const now = Date.now();
  const today = getTodayDateStr();
  await db.prepare(
    'INSERT OR IGNORE INTO user_trust (user_id, username, trust_status, consecutive_clean_count, last_clean_date, total_spam_count, last_message_at, created_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?)'
  ).bind(userId, username || null, 'new', today, now, now).run();
}

export async function incrementCleanCount(userId, env) {
  const db = env.TG_BOT_DB;
  const today = getTodayDateStr();
  const trust = await getUserTrust(userId, env);

  // 每日重置：跨天则归零计数和状态
  if (trust && trust.last_clean_date !== today) {
    await db.prepare(
      'UPDATE user_trust SET consecutive_clean_count = 1, trust_status = ?, last_clean_date = ?, last_message_at = ? WHERE user_id = ?'
    ).bind('new', today, Date.now(), userId).run();
    return;
  }

  // 同日则计数 +1
  await db.prepare(
    'UPDATE user_trust SET consecutive_clean_count = consecutive_clean_count + 1, last_message_at = ? WHERE user_id = ?'
  ).bind(Date.now(), userId).run();
}

export async function recordSpam(userId, env) {
  const db = env.TG_BOT_DB;
  const today = getTodayDateStr();
  await db.prepare(
    'UPDATE user_trust SET consecutive_clean_count = 0, last_clean_date = ?, total_spam_count = total_spam_count + 1, trust_status = ?, last_message_at = ? WHERE user_id = ?'
  ).bind(today, 'monitoring', Date.now(), userId).run();
}

export async function checkAndPromoteToWhitelist(userId, env) {
  const threshold = parseInt(await getConfig("ai_anti_harassment_trust_threshold", env)) || 3;
  const trust = await getUserTrust(userId, env);
  if (!trust) return false;
  if (trust.trust_status === 'trusted') return false;

  // 当日连续通过达到阈值即可加入 AI 信任列表（无累计垃圾次数门槛）
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

export async function trustUser(userId, by, env) {
  const db = env.TG_BOT_DB;
  const now = Date.now();
  const today = getTodayDateStr();
  await db.prepare(
    'INSERT OR REPLACE INTO user_trust (user_id, username, trust_status, consecutive_clean_count, last_clean_date, total_spam_count, whitelisted_at, whitelisted_by, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)'
  ).bind(userId, null, 'trusted', 0, today, now, by, now, now).run();
}

export async function untrustUser(userId, env) {
  const db = env.TG_BOT_DB;
  const today = getTodayDateStr();
  await db.prepare(
    'UPDATE user_trust SET trust_status = ?, consecutive_clean_count = 0, last_clean_date = ?, total_spam_count = total_spam_count + 1, whitelisted_at = NULL, whitelisted_by = NULL WHERE user_id = ?'
  ).bind('monitoring', today, userId).run();
}
```

### 2.4 `src/handlers/private.js` 修改

**修改点**：`handleVerifiedMsg` 函数中，在本地反骚扰检测通过后，新增 AI 检测环节

```javascript
async function handleVerifiedMsg(msg, u, env, ctx) {
  const id = u.user_id;

  if (u.is_blocked && !(await isAuthAdmin(id, env))) return;

  // 本地反骚扰消息检测（第一层）
  const msgCheck = await checkMessage(msg, env);
  if (msgCheck.triggered) {
    await handleMessageIntercept(id, msg.from, msgCheck.reason, env);
    return;
  }

  // AI 反骚扰检测（第二层，新增）
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
        await api(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: `✅ 用户 ${senderName} 当日连续通过 AI 检测，已加入 AI 信任列表（免检至当日结束）`
        }).catch(() => {});
      }
    }
  }

  // 原有逻辑继续：屏蔽词检测、类型过滤、转发...
  const text = msg.text || msg.caption || "";
  // ... (现有代码不变)
}
```

### 2.5 `src/handlers/adminReply.js` 修改

**新增 `/trust` 和 `/untrust` 命令处理**

```javascript
// 在管理员回复处理中新增命令识别
if (text === '/trust') {
  const userId = await getUserIdByTopicId(topicId, env);
  if (userId) {
    await trustUser(userId, 'admin', env);
    return api(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: topicId,
      text: "✅ 用户已加入 AI 信任列表（当日免检）"
    });
  }
  return api(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.ADMIN_GROUP_ID,
    message_thread_id: topicId,
    text: "⚠️ 未找到对应的用户映射"
  });
}

if (text === '/untrust') {
  const userId = await getUserIdByTopicId(topicId, env);
  if (userId) {
    await untrustUser(userId, env);
    return api(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: topicId,
      text: "⚠️ 用户已移出 AI 信任列表，重新进入 AI 检测"
    });
  }
  return api(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.ADMIN_GROUP_ID,
    message_thread_id: topicId,
    text: "⚠️ 未找到对应的用户映射"
  });
}
```

### 2.6 `src/utils/constants.js` 修改

```javascript
// DEFAULTS 新增
enable_ai_anti_harassment: "false",          // 默认关闭，需配置 LLM 环境变量后开启
ai_anti_harassment_trust_threshold: "3",     // 当日连续通过次数阈值
ai_anti_harassment_notify_auto_whitelist: "true"  // 自动加入 AI 信任列表时通知管理员
```

### 2.7 `src/database/index.js` 修改

```javascript
// dbInit() 新增表创建
await db.prepare(`
  CREATE TABLE IF NOT EXISTS user_trust (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    trust_status TEXT DEFAULT 'new',
    consecutive_clean_count INTEGER DEFAULT 0,
    last_clean_date TEXT,
    total_spam_count INTEGER DEFAULT 0,
    whitelisted_at INTEGER,
    whitelisted_by TEXT,
    last_message_at INTEGER,
    created_at INTEGER
  )
`).run();
```

## 3. 接口设计

### 3.1 LLM API 调用接口

使用原生 `fetch` API 调用 OpenAI Compatible Chat Completions API：

```
POST ${LLM_API}/chat/completions

Headers:
  Content-Type: application/json
  Authorization: Bearer ${LLM_KEY}

Body:
{
  "model": "${LLM_MODEL}",
  "temperature": 0.3,
  "messages": [
    { "role": "system", "content": "<SPAM_SYSTEM_PROMPT>" },
    { "role": "user", "content": "<filled SPAM_USER_PROMPT>" }
  ]
}

Response:
{
  "choices": [{
    "message": {
      "content": "SPAM:广告推广" 或 "CLEAN"
    }
  }]
}
```

### 3.2 内部接口总览

```javascript
// aiAntiHarassment.js
checkAiSpam(msg, user, env)         → { spam, reason, skipped, error }
handleAiSpamIntercept(userId, userInfo, reason, env) → void
handleAiCleanPass(userId, env)      → boolean (是否晋升AI信任列表)

// trust.js
getUserTrust(userId, env)           → trust info object | null
createUserTrust(userId, username, env) → void
incrementCleanCount(userId, env)    → void (含每日重置逻辑)
recordSpam(userId, env)             → void
checkAndPromoteToWhitelist(userId, env) → boolean
trustUser(userId, by, env)          → void
untrustUser(userId, env)            → void

// aiSpamPrompt.js
SPAM_SYSTEM_PROMPT                  → string
SPAM_USER_PROMPT_TEMPLATE           → string
fillPromptTemplate(template, vars)  → string
```

## 4. 数据流设计

### 4.1 AI 垃圾信息检测数据流

```
msg (Telegram Message) + user (DB User)
    │
    ▼
┌───────────────────┐
│ checkAiSpam()     │
│                   │
│ 1. 总开关检查     │ → 关闭 → { spam: false, skipped: true }
│ 2. 文本检查       │ → 无文本 → { spam: false, skipped: true }
│ 3. 每日重置检查 │ → 跨天 → 归零计数+状态回new
│ 4. AI信任检查   │ → trusted → { spam: false, skipped: true }
│ 5. 获取信任记录 │ → 无记录 → createUserTrust()
│ 6. 构造 prompt  │
│ 7. callLlmApi() │ → 超时/错误 → { spam: false, error: true }
│ 8. 解析结果     │
└──────────┬────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
  CLEAN        SPAM
     │           │
     ▼           ▼
handleAiClean  handleAiSpam
Pass()         Intercept()
     │           │
     ▼           ▼
incrementClean 1. recordSpam()
Count()         2. updateUser({is_blocked: true})
     │           3. manageBlacklist()
     ▼           4. 发送拦截提示
checkAndPromote 5. 通知管理员
ToWhitelist()
     │
     ▼
  达到阈值 → trustUser('auto')
  未达阈值 → 继续
```

### 4.2 管理员通知数据流

```
AI 检测为 SPAM
    │
    ▼
┌───────────────────┐
│ handleAiSpam       │
│ Intercept()        │
│                   │
│ 1. 发送拦截提示    │ → 用户收到 "您的消息因包含垃圾信息已被过滤"
│ 2. recordSpam()   │ → D1: trust_status=monitoring, count=0, spam+1
│ 3. updateUser()   │ → D1: is_blocked=true
│ 4. manageBlacklist│ → 管理群组黑名单通知
│ 5. 发送 AI 报告   │ → 管理群组收到：
│                   │   "🚨 AI 垃圾信息警告
│                   │    发送者: xxx (@xxx) (ID: xxx)
│                   │    AI 判定: SPAM:广告推广
│                   │    时间: 2026-05-14 12:00:00"
└───────────────────┘
```

## 5. 错误处理

### 5.1 LLM API 调用失败

```javascript
try {
  const judgment = await callLlmApi(env, systemPrompt, userPrompt);
  // 处理结果...
} catch (error) {
  console.error('[AiAntiHarassment] LLM API call failed:', error);
  // fail-open：不阻断消息，允许通过
  return { spam: false, error: true };
}
```

### 5.2 超时处理

```javascript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeout);
// fetch signal: controller.signal
// 超时触发 AbortError，进入 catch → fail-open
```

### 5.3 信任数据操作失败

```javascript
try {
  await incrementCleanCount(userId, env);
} catch (error) {
  console.error('[AiAntiHarassment] Trust DB operation failed:', error);
  // 不阻断消息流程，仅记录日志
}
```

### 5.4 错误汇总

| 错误场景 | 处理策略 | 用户影响 |
|----------|----------|----------|
| LLM API 返回非 200 | fail-open，记录错误日志 | 消息正常转发 |
| LLM API 超时 | fail-open（AbortController） | 消息正常转发 |
| LLM 返回空响应 | fail-open，记录错误日志 | 消息正常转发 |
| LLM 返回格式异常 | 视为 CLEAN（宽容策略） | 消息正常转发 |
| 信任数据操作失败 | 记录日志，不阻断 | 消息正常转发，下次重试信任记录 |
| 拦截处理失败 | 记录日志，不抛异常 | 用户可能收到部分通知 |

## 6. 性能考虑

### 6.1 API 调用延迟

- 白名单用户：0ms（跳过 AI 检测）
- 非白名单用户：~1-3s（LLM API 调用）
- 超时上限：5s（AbortController）
- 本地检测优先拦截：减少不必要的 AI API 调用

### 6.2 成本控制

- 白名单系统：trusted 用户完全跳过 AI 调用
- 仅文本消息检测：非文本消息（图片/语音/贴纸）仅本地检测
- 默认关闭：`enable_ai_anti_harassment` 默认 `false`，需手动开启
- 低成本模型推荐：`gpt-4o-mini` 约 $0.15/1M input tokens

### 6.3 Workers 限制

- Cloudflare Workers CPU 时间限制：30s（paid plan），10s（free plan）
- fetch 调用不计入 CPU 时间（subrequest）
- 5s 超时确保不超出 Workers 限制

### 6.4 缓存策略

```javascript
// 白名单检查可复用现有 60s 缓存
// 信任数据读取无额外缓存（D1 本身有内建缓存）
// 配置读取复用现有 getBoolConfig/getConfig 缓存机制
```

## 7. 安全考虑

### 7.1 LLM API Key 安全

- 环境变量存储，不硬编码
- Workers Secrets 管理（`wrangler secret put LLM_KEY`）
- 不在日志中输出 API Key

### 7.2 防误判

- 不确定时倾向于 CLEAN（prompt 中明确要求）
- fail-open 策略：AI 不可用时不误杀
- 白名单用户完全免检
- 管理员不受检测影响

### 7.3 防绕过

- 本地检测 + AI 检测双重屏障
- AI 信任列表仅当日有效，每日重置防止"刷一次永久免检"
- 黑名单优先于 AI 信任列表（流程顺序保证）
- 管理员可随时 `/untrust` 移出 AI 信任列表
- AI 信任列表与项目黑白名单完全解耦，拉黑时无需清理信任状态

### 7.4 Prompt 安全

- Prompt 模板固定，不接受用户输入
- 消息内容通过模板变量注入，不直接拼接
- 限制消息文本长度（取前 512 字符进行检测）

## 8. 测试策略

### 8.1 单元测试

```javascript
describe("checkAiSpam", () => {
  test("功能关闭时跳过检测", async () => {
    // enable_ai_anti_harassment = false
    const result = await checkAiSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("白名单用户跳过检测", async () => {
    // trust_status = 'trusted' (当日)
    const result = await checkAiSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("非文本消息跳过检测", async () => {
    // msg without text/caption
    const result = await checkAiSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.skipped).toBe(true);
  });

  test("SPAM 消息被识别", async () => {
    // LLM returns "SPAM:广告推广"
    const result = await checkAiSpam(msg, user, env);
    expect(result.spam).toBe(true);
    expect(result.reason).toBe("广告推广");
  });

  test("API 调用失败时 fail-open", async () => {
    // LLM_API unreachable
    const result = await checkAiSpam(msg, user, env);
    expect(result.spam).toBe(false);
    expect(result.error).toBe(true);
  });
});

describe("trust system", () => {
  test("当日连续通过 3 次进入 AI 信任列表", async () => {
    await incrementCleanCount(userId, env);
    await incrementCleanCount(userId, env);
    await incrementCleanCount(userId, env);
    const promoted = await checkAndPromoteToWhitelist(userId, env);
    expect(promoted).toBe(true);
  });

  test("跨天重置信任计数", async () => {
    // 昨日通过 2 次，今天第一条 → 计数归零从 1 开始
    // last_clean_date != today → 重置
    await incrementCleanCount(userId, env);
    const trust = await getUserTrust(userId, env);
    expect(trust.consecutive_clean_count).toBe(1);
    expect(trust.trust_status).toBe('new');
  });

  test("垃圾消息重置当日计数", async () => {
    await recordSpam(userId, env);
    const trust = await getUserTrust(userId, env);
    expect(trust.consecutive_clean_count).toBe(0);
    expect(trust.trust_status).toBe('monitoring');
  });

  test("/trust 手动加入 AI 信任列表", async () => {
    await trustUser(userId, 'admin', env);
    const trust = await getUserTrust(userId, env);
    expect(trust.trust_status).toBe('trusted');
  });

  test("/untrust 移出 AI 信任列表", async () => {
    await untrustUser(userId, env);
    const trust = await getUserTrust(userId, env);
    expect(trust.trust_status).toBe('monitoring');
  });

  test("AI信任列表与黑名单解耦", async () => {
    // 用户在 AI 信任列表中，被本地规则拉黑
    // AI 信任状态不受影响（两者独立）
    await trustUser(userId, 'admin', env);
    // 拉黑操作（本地反骚扰）: updateUser({is_blocked: true})
    // 不调用 untrustUser，AI 信任状态保持
    const trust = await getUserTrust(userId, env);
    expect(trust.trust_status).toBe('trusted');  // AI信任不变
    // 黑名单由 users.is_blocked 控制，与 user_trust 无关
  });
});
```

### 8.2 集成测试

- 测试完整流程：消息 → 本地检测 → AI 检测 → 白名单晋升 → 转发
- 测试 AI 不可用时的 fail-open 行为
- 测试 `/trust` `/untrust` 命令在管理群组中的操作
- 测试配置开关功能

## 9. 部署影响

### 9.1 文件变更清单

**新增文件**：
- `src/security/aiAntiHarassment.js` - AI 垃圾信息检测核心
- `src/security/aiSpamPrompt.js` - LLM prompt 模板
- `src/database/trust.js` - 用户信任度数据库操作

**修改文件**：
- `src/handlers/private.js` - 集成 AI 检测调用 + 白名单通知
- `src/handlers/adminReply.js` - 新增 /trust /untrust 命令
- `src/handlers/adminConfig.js` - 新增 AI 反骚扰配置区域
- `src/utils/constants.js` - 新增 AI 反骚扰默认配置
- `src/database/index.js` - 新增 user_trust 表初始化
- `wrangler.toml` - 无需修改（LLM 配置为环境变量/Secrets）

### 9.2 环境变量配置

```bash
# 通过 wrangler secret put 设置（不写入 wrangler.toml）
wrangler secret put LLM_KEY

# 普通环境变量（可写入 wrangler.toml 或 Dashboard 设置）
LLM_API=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_MS=5000
```

### 9.3 配置迁移

首次部署时：
1. AI 反骚扰默认关闭（`enable_ai_anti_harassment = false`）
2. 配置 LLM 环境变量后手动开启
3. `user_trust` 表由 `dbInit()` 自动创建

### 9.4 回滚策略

- 关闭 `enable_ai_anti_harassment` 配置即可完全回退到纯本地检测
- 无需回滚代码，功能开关控制

## 10. 与参考项目 (telegram-watchdog) 的对比

| 维度 | telegram-watchdog | 本项目方案 |
|------|-------------------|-----------|
| LLM 调用方式 | OpenAI SDK (npm) | 原生 fetch API |
| 运行环境 | Node.js / Workers | Cloudflare Workers (纯 JS) |
| 框架 | Grammy + Hono | 原生 Webhook + 自建路由 |
| 数据库 | D1 / node:sqlite | D1 |
| 白名单系统 | user_trust 表（永久白名单） | user_trust 表（每日重置的AI信任列表，与黑白名单解耦） |
| Prompt 模板 | 独立 llm/prompt.ts | 独立 aiSpamPrompt.js |
| 消息转发 | Grammy middleware | handlers/private.js 集成 |
| 管理员命令 | Grammy command | adminReply.js 回复识别 |
| 错误策略 | 中间件失败不放行 | fail-open 放行 |
| 与本地检测关系 | 无本地检测层 | 本地检测优先 + AI 第二层 |

**关键适配**：
- Workers 环境下不能使用 npm SDK，改用 fetch API
- 不使用 Grammy 框架，在现有 handlers 层集成
- AI 信任列表参照 telegram-watchdog 信任系统设计，但适配本项目 D1 操作模式
- AI 信任列表与项目黑白名单完全解耦，互不影响
- 信任每日重置（跨天归零），而非永久白名单
- 在本地检测通过后追加 AI 检测层，而非替代