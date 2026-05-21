# AI 长期记忆功能技术设计文档

## 方案选择

**废弃方案**: 302.AI Memobase 云服务（已关闭）

**采用方案**: D1 存储 + LLM 定期总结 + 实时热更新

---

## 1. 架构概述

### 1.1 核心思路

不需要引入任何第三方"记忆服务"，利用项目现有的 D1 数据库和 LLM API，通过"定期总结 + 实时注入"实现长期记忆功能。

### 1.2 记忆分层

| 层级 | 数据来源 | 存储位置 | 更新频率 | 作用 |
|------|----------|----------|----------|------|
| **长期规则** | LLM 从历史纠正中总结提炼 | D1 `ai_rules` 表 | 定期触发（Cron，如每 6 小时） | 提供通用判定规则，实现"举一反三" |
| **热纠正** | 管理员实时纠正记录 | D1 `ai_corrections` 表 | 实时写入 | 确保最近的纠正立即生效 |

### 1.3 系统架构图

```
+---------------------------------------------------------------------+
|                        Telegram 用户/管理员                           |
+------------------------------+--------------------------------------+
                               |
                               v
+---------------------------------------------------------------------+
|                     Cloudflare Workers                               |
|                                                                      |
|  ┌───────────────────────────────────────────────────────────────+  |
|  |  写入阶段 (管理员纠正)                                          |  |
|  |  ┌─────────────────┐    ┌─────────────────────────────────+  |  |
|  |  | 误判纠正 (SPAM  |    | 1. 写入 D1 ai_corrections 表     |  |  |
|  |  |    → CLEAN)     |--->| 2. 解除用户黑名单                |  |  |
|  |  └─────────────────┘    └─────────────────────────────────+  |  |
|  |  ┌─────────────────┐    ┌─────────────────────────────────+  |  |
|  |  | 漏判纠正 (CLEAN |    | 1. 写入 D1 ai_corrections 表     |  |  |
|  |  |    → SPAM)      |--->| 2. 信任度清零 (熔断)            |  |  |
|  |  └─────────────────┘    | 3. 执行拉黑                      |  |  |
|  |                         └─────────────────────────────────+  |  |
|  +---------------------------------------------------------------+  |
|                                                                      |
|  ┌───────────────────────────────────────────────────────────────+  |
|  |  检测阶段 (用户发消息)                                          |  |
|  |                                                                 |  |
|  |  ┌─────────────────┐    ┌─────────────────────────────────+  |  |
|  |  | 获取长期规则     |--->| SELECT content FROM ai_rules    |  |  |
|  |  └─────────────────┘    └─────────────────────────────────+  |  |
|  |  ┌─────────────────┐    ┌─────────────────────────────────+  |  |
|  |  | 获取热纠正       |--->| SELECT * FROM ai_corrections    |  |  |
|  |  | (最近 3 条)      |    | ORDER BY created_at DESC LIMIT 3|  |  |
|  |  └─────────────────┘    └─────────────────────────────────+  |  |
|  |                              |                                |  |
|  |  ┌───────────────────────────v─────────────────────────────+  |  |
|  |  | 构建增强 Prompt                                          |  |  |
|  |  | [原始提示词] + [长期规则] + [热纠正] + [当前消息]       |  |  |
|  |  +---------------------------------------------------------+  |  |
|  |                              |                                |  |
|  |  ┌───────────────────────────v─────────────────────────────+  |  |
|  |  | 调用 LLM API 判定                                        |  |  |
|  |  └─────────────────────────────────────────────────────────+  |  |
|  +---------------------------------------------------------------+  |
|                                                                      |
|  ┌───────────────────────────────────────────────────────────────+  |
|  |  维护阶段 (Cron 定时任务)                                       |  |
|  |                                                                 |  |
|  |  1. 查询未总结的纠正记录                                         |  |
|  |  2. 调用 LLM 总结提炼通用规则                                    |  |
|  |  3. 更新 ai_rules 表                                            |  |
|  |  4. 标记纠正记录为已总结                                         |  |
|  +---------------------------------------------------------------+  |
|                                                                      |
+---------------------------------------------------------------------+
                               |
                               v
+---------------------------------------------------------------------+
|                     Cloudflare D1 数据库                              |
|                                                                      |
|  ┌─────────────────┐    ┌─────────────────┐                         |
|  | ai_corrections  |    | ai_rules        |                         |
|  | (纠正记录表)    |    | (规则摘要表)    |                         |
|  | user_msg        |    | id (PK)         |                         |
|  | correct_result  |    | content         |                         |
|  | reason          |    +─────────────────┘                         |
|  | is_summarized   |                                                |
|  | created_at      |                                                |
|  └─────────────────┘                                                |
+---------------------------------------------------------------------+
```

### 1.4 核心设计原则

1. **零外部依赖**：不引入任何第三方记忆服务，数据完全在 D1 中
2. **LLM 自动抽象**：利用 LLM 的总结能力，将大量纠正提炼为少量规则，永远不撑爆 Prompt
3. **实时与长效结合**：热纠正保证即时生效，长期规则保证举一反三
4. **动态导入**：记忆相关模块使用动态 `import()`，确保功能关闭时不影响原有流程

---

## 2. 数据库设计

### 2.1 新增表结构

#### 2.1.1 `ai_corrections` - 纠正记录表

```sql
CREATE TABLE ai_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_msg TEXT NOT NULL,
    original_judgment TEXT NOT NULL,
    correct_result TEXT NOT NULL,
    reason TEXT,
    is_summarized INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_ai_corrections_unsummarized ON ai_corrections(is_summarized);
CREATE INDEX idx_ai_corrections_created ON ai_corrections(created_at);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | TEXT | 用户 ID |
| `user_msg` | TEXT | 原始消息内容（截取前 512 字符） |
| `original_judgment` | TEXT | AI 原始判定（SPAM 或 CLEAN） |
| `correct_result` | TEXT | 纠正后的正确结果（SPAM 或 CLEAN） |
| `reason` | TEXT | 纠正理由（可选） |
| `is_summarized` | INTEGER | 是否已被总结进规则（0=否，1=是） |
| `created_at` | INTEGER | 创建时间戳 |

#### 2.1.2 `ai_rules` - 规则摘要表

```sql
CREATE TABLE ai_rules (
    id INTEGER PRIMARY KEY DEFAULT 1,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 初始化一条空规则
INSERT OR IGNORE INTO ai_rules (id, content, updated_at) VALUES (1, '', 0);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 固定为 1（单条记录） |
| `content` | TEXT | LLM 总结后的通用规则文本 |
| `updated_at` | INTEGER | 最后一次更新的时间戳 |

### 2.2 规则文本格式示例

`ai_rules.content` 存储的文本格式（由 LLM 生成）：

```
- 包含"加微信"、"领福利"、"点击链接"等引流话术的消息属于 SPAM
- 正常用户询问产品功能、价格、售后服务的消息属于 CLEAN
- 包含短链接（如 t.cn, bit.ly）的推广消息属于 SPAM
- 用户发送的纯代码片段、技术问题讨论属于 CLEAN
- 冒充官方客服索要个人信息的消息属于 SPAM
```

---

## 3. 模块设计

### 3.1 新增模块

#### 3.1.1 `src/services/aiMemory.js` - AI 记忆管理服务

职责：
- 写入纠正记录到 D1
- 读取长期规则和热纠正
- 构建记忆增强 Prompt
- 触发 LLM 定期总结

核心方法：

```javascript
export async function addCorrection(userId, userMsg, originalJudgment, correctResult, reason, env)
// 写入纠正记录

export async function getMemoryContext(limit = 3, env)
// 获取长期规则 + 最近 N 条热纠正

export async function summarizeCorrections(env)
// 调用 LLM 总结未处理的纠正记录

export async function buildPromptWithMemory(basePrompt, env)
// 构建包含记忆上下文的增强 Prompt
```

#### 3.1.2 `src/security/aiMemoryPrompt.js` - 记忆提示词模板

提供记忆注入的模板和格式化工具。

### 3.2 修改模块

#### 3.2.1 `src/security/aiAntiHarassment.js`

- `checkAiSpam()`: 调用 `buildPromptWithMemory()` 获取增强提示词
- `handleAiSpamIntercept()`: 通知按钮保持不变

#### 3.2.2 `src/handlers/callback.js`

- 纠正回调: 调用 `addCorrection()` 写入 D1，同时执行本地动作（解除黑名单/信任熔断）

#### 3.2.3 `src/database/index.js`

- `dbInit()`: 新增 `ai_corrections` 和 `ai_rules` 表创建

#### 3.2.4 `wrangler.toml`

- 新增 Cron 触发器配置

---

## 4. 数据流设计

### 4.1 检测流程

```
用户发送消息
    |
    v
+-------------------------------------+
| 1. 检查信任列表                      |
|    trusted → 跳过                   |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 2. 获取记忆上下文                    |
|    getMemoryContext()               |
|    - SELECT content FROM ai_rules   |
|    - SELECT * FROM ai_corrections   |
|      LIMIT 3                        |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 3. 构建增强 Prompt                   |
|    [原始提示词] + [规则] + [热纠正]  |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 4. 调用 LLM API 判定                 |
+--------+----------------------------+
         |
    ┌────┴────┐
    v         v
 SPAM      CLEAN
    |         |
    v         v
 拦截+通知   放行
```

### 4.2 纠正流程

#### 误判纠正 (SPAM → CLEAN)

```
管理员点击"误判，放行"
    |
    v
+-------------------------------------+
| 1. 写入纠正记录到 D1                 |
|    ai_corrections 表                |
|    is_summarized = 0                |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 2. 解除用户黑名单                    |
|    is_blocked = 0                   |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 3. 发送确认通知                      |
|    "误判纠正已生效"                  |
+-------------------------------------+
```

#### 漏判纠正 (CLEAN → SPAM)

```
管理员回复消息并发送 "/markspam"
    |
    v
+-------------------------------------+
| 1. 写入纠正记录到 D1                 |
|    ai_corrections 表                |
|    is_summarized = 0                |
|    记录原文: "这是 SPAM"            |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 2. 触发信任熔断                      |
|    清零信任度                        |
|    status = monitoring              |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 3. 执行拉黑操作                      |
|    is_blocked = 1                   |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 4. 自动删除该垃圾消息                |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 5. 发送确认通知                      |
|    "漏判纠正已生效，用户已拉黑"      |
+-------------------------------------+
```

### 4.3 定期总结流程 (Cron)

```
Cron 触发 (每 6 小时)
    |
    v
+-------------------------------------+
| 1. 查询未总结的纠正记录              |
|    WHERE is_summarized = 0          |
+--------+----------------------------+
         |
         | 有记录?
    ┌────┴────┐
    | 否      | 是
    v         v
 结束      +-------------------------------------+
            | 2. 获取现有规则                    |
            |    SELECT content FROM ai_rules    |
            +--------+----------------------------+
                     |
                     v
            +-------------------------------------+
            | 3. 调用 LLM 总结                     |
            |    Prompt:                           |
            |    "根据以下新纠正记录更新规则..."    |
            +--------+----------------------------+
                     |
                     v
            +-------------------------------------+
            | 4. 更新规则表                        |
            |    UPDATE ai_rules                  |
            |    SET content = 新规则             |
            +--------+----------------------------+
                     |
                     v
            +-------------------------------------+
            | 5. 标记纠正记录为已总结              |
            |    UPDATE ai_corrections            |
            |    SET is_summarized = 1            |
            +-------------------------------------+
```

---

## 5. 核心代码实现

### 5.1 LLM 总结 Prompt 模板

```
你是一个反骚扰规则提炼专家。请根据以下管理员纠正记录，更新并提炼通用的反垃圾判定规则。

现有规则：
{{existing_rules}}

新的纠正记录（格式: 原文 | AI原判定 | 正确结果 | 理由）：
{{new_corrections}}

请输出更新后的规则列表。要求：
1. 规则应通用化，不要针对某个具体用户
2. 保留原有规则中仍然有效的部分
3. 从新记录中提炼新的模式特征
4. 每条规则简洁明了，50字以内
5. 只输出规则列表，不要其他废话
6. 如果新记录没有提供有价值的模式，保持原有规则不变
```

### 5.2 记忆注入 Prompt 模板

```
## 🔴 历史判定经验参考

### 通用规则（由历史纠正自动提炼）：
{{long_term_rules}}

### 近期纠正案例：
{{recent_corrections}}

注意：
- 通用规则是长期积累提炼的，优先级较高
- 近期纠正是最近的管理员确认，请重点关注
```

### 5.3 `src/services/aiMemory.js` 核心逻辑

```javascript
import { log, logError } from '../utils/logger.js';
import { callLlmApi } from '../security/aiAntiHarassment.js';
import { MEMORY_INJECT_TEMPLATE, SUMMARIZE_PROMPT_TEMPLATE } from '../security/aiMemoryPrompt.js';

const HOT_CORRECTION_LIMIT = 3; // 热纠正条数上限

export async function addCorrection(userId, userMsg, originalJudgment, correctResult, reason, env) {
  const db = env.TG_BOT_DB;
  await db.prepare(
    'INSERT INTO ai_corrections (user_id, user_msg, original_judgment, correct_result, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(userId, userMsg.substring(0, 512), originalJudgment, correctResult, reason || '', Date.now()).run();
}

export async function getMemoryContext(env) {
  const db = env.TG_BOT_DB;
  
  // 获取长期规则
  const rulesRes = await db.prepare("SELECT content FROM ai_rules WHERE id = 1").first();
  const longTermRules = rulesRes?.content || '';
  
  // 获取热纠正
  const recentRes = await db.prepare(
    "SELECT user_msg, correct_result, reason FROM ai_corrections ORDER BY created_at DESC LIMIT ?"
  ).bind(HOT_CORRECTION_LIMIT).all();
  
  const recentCorrections = recentRes.results.map(r => 
    `- 原文: "${r.user_msg.substring(0, 80)}..." → 纠正为: ${r.correct_result}${r.reason ? ` (${r.reason})` : ''}`
  ).join('\n');
  
  return { longTermRules, recentCorrections };
}

export async function buildPromptWithMemory(basePrompt, env) {
  const { longTermRules, recentCorrections } = await getMemoryContext(env);
  
  if (!longTermRules && !recentCorrections) return basePrompt;
  
  return basePrompt + MEMORY_INJECT_TEMPLATE
    .replace('{{long_term_rules}}', longTermRules || '暂无积累')
    .replace('{{recent_corrections}}', recentCorrections || '暂无');
}

export async function summarizeCorrections(env) {
  const db = env.TG_BOT_DB;
  
  // 获取未总结的记录
  const records = await db.prepare(
    "SELECT user_msg, original_judgment, correct_result, reason FROM ai_corrections WHERE is_summarized = 0 ORDER BY created_at ASC LIMIT 50"
  ).all();
  
  if (records.results.length === 0) {
    log.info('AiMemory', 'No new corrections to summarize');
    return;
  }
  
  // 获取现有规则
  const rulesRes = await db.prepare("SELECT content FROM ai_rules WHERE id = 1").first();
  const existingRules = rulesRes?.content || '无';
  
  // 构建总结数据
  const correctionLines = records.results.map(r => 
    `"${r.user_msg.substring(0, 80)}" | AI: ${r.original_judgment} | 正确: ${r.correct_result} | 理由: ${r.reason || '无'}`
  ).join('\n');
  
  // 调用 LLM 总结
  const summarizePrompt = SUMMARIZE_PROMPT_TEMPLATE
    .replace('{{existing_rules}}', existingRules)
    .replace('{{new_corrections}}', correctionLines);
  
  try {
    const newRules = await callLlmApi(env, '你是一个反骚扰规则提炼专家。请根据输入提炼规则，只输出规则列表。', summarizePrompt);
    
    // 更新规则表和标记已总结
    await db.batch([
      db.prepare("UPDATE ai_rules SET content = ?, updated_at = ? WHERE id = 1").bind(newRules, Date.now()),
      db.prepare("UPDATE ai_corrections SET is_summarized = 1 WHERE is_summarized = 0")
    ]);
    
    log.info('AiMemory', `Summarized ${records.results.length} corrections into rules`);
  } catch (e) {
    logError('AiMemory', 'Summarization failed', e);
  }
}
```

---

## 6. Cron 配置

### 6.1 `wrangler.toml` 新增

```toml
# Cron 触发器 - 每 6 小时执行一次 AI 记忆总结
[triggers]
crons = ["0 */6 * * *"]
```

### 6.2 `src/index.js` 新增入口

```javascript
export default {
  async fetch(req, env, ctx) { ... },
  
  async scheduled(event, env, ctx) {
    if (event.cron === "0 */6 * * *") {
      const { summarizeCorrections } = await import('./services/aiMemory.js');
      await summarizeCorrections(env);
    }
  }
};
```

---

## 7. 部署方案

### 7.1 环境变量

| 变量 | 说明 | 默认值 |
|------|------|----------|
| `ENABLE_AI_MEMORY` | 长期记忆功能开关 (`true`/`false`) | **`true`** (默认开启) |

**默认跟随逻辑**：
- 当 **AI 反骚扰总开关** 开启时，**长期记忆功能默认生效**。
- 只有在环境变量显式设置 `ENABLE_AI_MEMORY=false` 时，才会关闭记忆功能（降级为纯 Prompt 模式）。

不需要额外的外部服务，无需配置 API Key。

### 7.2 数据库迁移

代码在 `dbInit()` 中自动创建 `ai_corrections` 和 `ai_rules` 表，无需手动执行 SQL。

---

## 8. 性能与成本控制

### 8.1 存储成本

- 单条纠正记录约 500 字节
- 1000 条记录约 500KB
- D1 免费额度 10GB，完全够用

### 8.2 LLM 调用成本

- **检测时**：每次检测调用 1 次 LLM（原有行为，无额外成本）
- **总结时**：每 6 小时最多 1 次 LLM 调用（仅当有新纠正时）
- 每天最多 4 次总结调用，费用几乎为零

### 8.3 查询性能

- 规则查询：`SELECT content FROM ai_rules WHERE id = 1` → 毫秒级
- 热纠正查询：`ORDER BY created_at DESC LIMIT 3` → 毫秒级（有索引）
- 总结查询：`WHERE is_summarized = 0` → 毫秒级（有索引）

---

## 9. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| LLM 总结质量差 | 规则不准确，影响判定 | 低 | Prompt 精心设计，可人工查看并手动修正 ai_rules 内容 |
| 热纠正过多 | Prompt 过长 | 极低 | 严格限制 3 条，且每条截取 80 字符 |
| 总结任务失败 | 规则不更新 | 低 | 热纠正仍实时生效，下次 Cron 重试 |
| D1 写入失败 | 纠正丢失 | 极低 | fail-open，不影响原有检测流程 |
