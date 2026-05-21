# AI 长期记忆功能技术规格文档 (Technical Specification)

本文档基于《AI 长期记忆功能技术设计文档》编写，侧重于具体的代码实现、数据结构定义、Prompt 工程设计以及测试策略，供开发人员直接参照实施。

---

## 1. 数据库详细设计 (D1)

### 1.1 表定义

#### 1.1.1 `ai_corrections` (纠正记录表)
存储每一次管理员的人工干预记录。

```sql
CREATE TABLE IF NOT EXISTS ai_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,              -- 触发纠正的用户 ID
    user_msg TEXT NOT NULL,             -- 用户原始消息内容 (截取前 512 字符)
    original_judgment TEXT NOT NULL,    -- AI 原始判定结果 ('SPAM' 或 'CLEAN')
    correct_result TEXT NOT NULL,       -- 纠正后的正确结果 ('SPAM' 或 'CLEAN')
    reason TEXT DEFAULT '',             -- 纠正理由 (可选，由系统自动生成或管理员填写)
    is_summarized INTEGER DEFAULT 0,    -- 标记位：0=未提炼，1=已提炼入规则库
    created_at INTEGER NOT NULL         -- 记录创建时间戳 (毫秒)
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_corrections_unsummarized ON ai_corrections(is_summarized);
CREATE INDEX IF NOT EXISTS idx_corrections_created ON ai_corrections(created_at);
```

#### 1.1.2 `ai_rules` (规则摘要表)
存储由 LLM 总结提炼后的通用判定规则。

```sql
CREATE TABLE IF NOT EXISTS ai_rules (
    id INTEGER PRIMARY KEY DEFAULT 1,   -- 固定 ID 为 1，单例模式
    content TEXT NOT NULL DEFAULT '',   -- 规则文本内容 (Markdown 列表格式)
    updated_at INTEGER DEFAULT 0        -- 最后一次更新时间戳
);

-- 初始化空记录 (由 dbInit 执行)
INSERT OR IGNORE INTO ai_rules (id, content, updated_at) VALUES (1, '', 0);
```

### 1.2 数据库操作语句清单

| 操作 | 语句 | 说明 |
| :--- | :--- | :--- |
| **写入纠正** | `INSERT INTO ai_corrections (...) VALUES (?, ?, ?, ?, ?, ?)` | `is_summarized` 默认为 0 |
| **读取规则** | `SELECT content FROM ai_rules WHERE id = 1` | 获取长期记忆上下文 |
| **读取热纠正**| `SELECT user_msg, correct_result, reason FROM ai_corrections ORDER BY created_at DESC LIMIT ?` | 获取最近 N 条纠正记录 |
| **查询未总结**| `SELECT * FROM ai_corrections WHERE is_summarized = 0 ORDER BY created_at ASC LIMIT 50` | Cron 任务获取待处理数据 |
| **更新规则** | `UPDATE ai_rules SET content = ?, updated_at = ? WHERE id = 1` | LLM 总结后更新 |
| **标记总结** | `UPDATE ai_corrections SET is_summarized = 1 WHERE is_summarized = 0` | 标记记录已处理 |

---

## 2. 核心接口规格

### 2.1 模块：`src/services/aiMemory.js`

该模块封装所有与长期记忆相关的业务逻辑。

#### 函数 1: `addCorrection`
用于在管理员触发纠正回调时调用。

*   **输入参数**:
    *   `userId` (string): 用户 ID
    *   `userMsg` (string): 原始消息文本
    *   `originalJudgment` (string): 'SPAM' | 'CLEAN'
    *   `correctResult` (string): 'SPAM' | 'CLEAN'
    *   `reason` (string): 纠正原因
    *   `env` (object): 环境变量
*   **执行逻辑**:
    1.  校验 `env.TG_BOT_DB` 是否存在。
    2.  截取 `userMsg` 前 512 字符防止超长。
    3.  执行 `INSERT` 语句。
    4.  记录 Debug 日志。

#### 函数 2: `buildPromptWithMemory`
用于在 AI 检测前动态构建增强 System Prompt。

*   **输入参数**:
    *   `basePrompt` (string): 原始的 `SPAM_SYSTEM_PROMPT`
    *   `env` (object): 环境变量
*   **返回**:
    *   `string`: 拼接后的完整 Prompt
*   **执行逻辑**:
    1.  调用 `getRules(env)` 获取长期规则。
    2.  调用 `getRecentCorrections(env)` 获取最近 3 条热纠正。
    3.  若两者皆空，直接返回 `basePrompt`。
    4.  否则，使用 `MEMORY_INJECT_TEMPLATE` 模板替换变量后拼接到 `basePrompt` 后面。

#### 函数 3: `summarizeCorrections` (供 Cron 调用)
用于定期将纠正记录提炼为规则。

*   **输入参数**:
    *   `env` (object): 环境变量
*   **执行逻辑**:
    1.  查询 `is_summarized = 0` 的记录，Limit 50 条。
    2.  若无新记录，Log Info 并返回。
    3.  构建 Summary Prompt（见 3.2 节）。
    4.  调用 `callLlmApi`。
    5.  **关键处理**: 检查 LLM 返回值是否为空。若非空，执行事务更新：
        *   `UPDATE ai_rules` 写入新规则。
        *   `UPDATE ai_corrections` 批量标记 `is_summarized = 1`。

---

## 3. 提示词工程 (Prompt Engineering)

### 3.1 记忆注入模板 (`MEMORY_INJECT_TEMPLATE`)

此模板拼接到原始反骚扰 System Prompt 之后。

```text
============================================
## 🧠 历史判定经验参考 (长期记忆)

### 1. 通用判定规则 (由历史纠正提炼)
以下规则基于过往管理员的纠正记录提炼，请作为重要参考依据：
{{long_term_rules}}

### 2. 近期人工纠正案例 (实时热数据)
以下是最近管理员纠正的几条具体案例，请重点关注其模式特征：
{{recent_corrections}}

### 判定指导
- 当遇到与上述规则或案例相似的消息特征（如关键词、句式、链接模式）时，请倾向于参考历史经验进行判定。
- 保持独立分析，但需高度重视管理员的人工反馈权重。
============================================
```

### 3.2 规则提炼 Prompt (`SUMMARIZE_PROMPT_TEMPLATE`)

此 Prompt 专供 Cron 任务调用 LLM 总结使用。

```text
你是一个资深的风控策略专家。请根据以下数据，更新并提炼一套通用的"垃圾信息 (SPAM) 判定规则"。

## 现有规则库
{{existing_rules}}

## 新增管理员纠正记录 (原文 | AI 原判 | 正确结果 | 理由)
{{new_corrections}}

## 任务要求
1. **融合与提炼**: 结合新记录，更新现有规则。如果新记录揭示了新的垃圾模式，请加入规则库。
2. **通用化**: 规则必须是通用的判定逻辑（例如"包含诱导加群链接"），禁止包含具体用户的 ID 或具体某句话。
3. **去重**: 如果新记录没有提供新价值，保持规则库不变。
4. **格式**: 仅输出 Markdown 列表格式的规则文本，不要包含任何解释性前言或后语。
5. **长度**: 控制在 500 字以内。
```

---

## 4. Cron Job 技术实现

### 4.1 `wrangler.toml` 配置

```toml
[triggers]
crons = ["0 */6 * * *"]
```
*   **频率**: 每 6 小时执行一次（每天 4 次），平衡规则实时性与 LLM 调用成本。

### 4.2 `src/index.js` 入口接入

在 Worker 的 `scheduled` 事件中分发任务。

```javascript
export default {
  async fetch(request, env, ctx) {
    // ... 原有的 fetch 逻辑 ...
  },

  async scheduled(event, env, ctx) {
    console.log(`Cron Triggered: ${event.cron}`);
    
    // 默认跟随模式：除非显式关闭，否则只要 AI 开启就执行总结
    if (env.ENABLE_AI_MEMORY !== 'false') {
      const { summarizeCorrections } = await import('./services/aiMemory.js');
      ctx.waitUntil(summarizeCorrections(env));
    }
  }
};
```
*   **注意**: 使用 `ctx.waitUntil` 确保后台任务执行完毕，不阻塞 Cron 响应。

---

## 5. 代码修改清单 (Impact Analysis)

### 5.1 新增文件

| 文件路径 | 说明 |
| :--- | :--- |
| `src/services/aiMemory.js` | 记忆服务核心逻辑 (CRUD + Prompt 构建 + 总结) |
| `src/security/aiMemoryPrompt.js` | Prompt 模板定义文件 |

### 5.2 修改文件

| 文件路径 | 修改点 | 说明 |
| :--- | :--- | :--- |
| `src/security/aiAntiHarassment.js` | `checkAiSpam` | 调用 `buildPromptWithMemory` 获取增强 Prompt |
| `src/handlers/callback.js` | 纠正回调处理 | 处理拦截通知上的按钮点击（误判纠正） |
| `src/handlers/adminReply.js` | 命令处理 | **新增 `/markspam` 命令**，处理回复消息的漏判纠正 |
| `src/database/index.js` | `dbInit` | 增加新表的 `CREATE TABLE` 逻辑 |
| `src/index.js` | `scheduled` | 接入 Cron 任务入口 |
| `wrangler.toml` | `[triggers]` | 增加 Cron 配置 |
| `README.md` | 文档 | 更新环境变量说明 (`ENABLE_AI_MEMORY`) |

---

## 6. 测试计划

### 6.1 单元测试 (本地 Mock)

*   **场景 A: 无记忆注入测试**
    *   前置：D1 中无规则、无纠正记录。
    *   预期：`buildPromptWithMemory` 返回原始 Prompt。
*   **场景 B: 热纠正注入测试**
    *   前置：写入 5 条纠正记录。
    *   预期：Prompt 中包含最近 3 条记录，且按时间倒序排列。

### 6.2 集成测试 (部署后)

*   **流程 1: 误判纠正闭环**
    1.  发消息触发 AI 误判拦截。
    2.  点击"放行 (CLEAN)"。
    3.  **检查点**: 查询 D1 `ai_corrections` 表是否新增一条 `is_summarized=0` 的记录？用户黑名单是否解除？
    4.  发类似消息。
    5.  **检查点**: AI 是否正确判定为 CLEAN（因为 Prompt 注入了热纠正）？

*   **流程 2: Cron 总结生效**
    1.  手动触发 Cron (`wrangler trigger`)。
    2.  **检查点**: 查询 D1 `ai_rules` 表，`content` 字段是否更新为规则文本？
    3.  **检查点**: `ai_corrections` 表中旧记录的 `is_summarized` 是否变为 1？
    4.  发一条包含新规则特征的消息。
    5.  **检查点**: AI 是否依据新规则拦截？

---

## 7. 风险与降级策略

*   **风险**: D1 写入超时或失败。
    *   **降级**: `addCorrection` 捕获异常并 Log Error，**不阻断**原有的解除黑名单/信任熔断逻辑。
*   **风险**: LLM 总结失败（如超时、返回格式错误）。
    *   **降级**: 记录日志，保持旧规则不变，下次 Cron 重试。热纠正依然实时生效，不影响业务。
*   **风险**: Prompt 注入导致判定逻辑混乱。
    *   **降级**: 监控 AI 判定的 SPAM/CLEAN 比例。若比例异常，可一键关闭 `ENABLE_AI_MEMORY` 回退到纯 Prompt 模式。
