# AI 长期记忆功能技术设计文档

## 1. 架构概述

### 1.1 系统架构图

```
+---------------------------------------------------------------------+
|                        Telegram 用户/管理员                           |
+------------------------------+--------------------------------------+
                               |
                               v
+---------------------------------------------------------------------+
|                     Cloudflare Workers                               |
|                                                                      |
|  +---------------------------------------------------------------+  |
|  |  AI 反骚扰检测 (src/security/aiAntiHarassment.js)             |  |
|  |  +-----------------+    +----------------------------------+  |  |
|  |  | 1. 检查总开关   |--->| 2. 检查信任列表                   |  |  |
|  |  |  enable_ai_*   |    |  user_trust 表                    |  |  |
|  |  +-----------------+    +----------------+-----------------+  |  |
|  |                                         |                     |  |
|  |  +--------------------------------------v------------------+  |  |
|  |  | 3. 获取 Memobase 记忆上下文 (新增)                       |  |  |
|  |  |  memobaseService.getUserContext(userId)                 |  |  |
|  |  +----------------------+---------------------------------+  |  |
|  |                           |                                   |  |
|  |  +-----------------------v---------------------------------+  |  |
|  |  | 4. 构建增强提示词 (修改)                                 |  |  |
|  |  |  systemPrompt + memoryContext + userMessage             |  |  |
|  |  +----------------------+---------------------------------+  |  |
|  |                           |                                 |  |
|  |  +-----------------------v---------------------------------+  |  |
|  |  | 5. 调用 LLM API 判定                                      |  |  |
|  |  |  callLlmApi()                                            |  |  |
|  |  +----------------------+---------------------------------+  |  |
|  |                           |                                 |  |
|  |  +-----------------------v---------------------------------+  |  |
|  |  | 6. 存储判定结果到 Memobase (新增)                        |  |  |
|  |  |  memobaseService.recordJudgment()                       |  |  |
|  |  +---------------------------------------------------------+  |  |
|  +---------------------------------------------------------------+  |
|                                                                      |
|  +---------------------------------------------------------------+  |
|  |  管理员纠正回调 (src/handlers/callback.js - 新增)             |  |
|  |  +-----------------+    +----------------------------------+  |  |
|  |  | 管理员点击纠正  |--->| memobaseService                  |  |  |
|  |  |  按钮           |    |  .recordCorrection()             |  |  |
|  |  +-----------------+    +----------------------------------+  |  |
|  +---------------------------------------------------------------+  |
+------------------------------+--------------------------------------+
                               |
                               v
+---------------------------------------------------------------------+
|                     302.AI Memobase 云服务                            |
|  BASE_URL: https://api.302.ai                                       |
|  API 路径前缀: /memobase/api/v1/                                    |
|                                                                      |
|  +-----------------+    +-----------------+    +-----------------+  |
|  |  用户管理       |    |  数据管理       |    |  记忆管理       |  |
|  |  Create/Get/    |    |  Insert/Get/    |    |  Flush/Profile/ |  |
|  |  Update/Delete  |    |  Delete Blobs   |    |  Context/Events |  |
|  +-----------------+    +-----------------+    +-----------------+  |
+---------------------------------------------------------------------+
```

### 1.2 核心设计原则

1. **非阻塞设计**：Memobase API 调用不应阻塞消息处理主流程
2. **Fail-Open 策略**：Memobase 不可用时，AI 检测降级为无记忆模式继续工作
3. **向后兼容**：现有 AI 反骚扰检测逻辑保持不变，记忆功能作为增强层
4. **配置驱动**：通过管理面板控制记忆功能的启用/禁用

---

## 2. 302.AI Memobase API 详解

### 2.1 服务地址

| 环境 | BASE_URL |
|------|----------|
| 正式环境 | https://api.302.ai |
| 国内中转 | https://api.302ai.cn |

所有 API 路径前缀：`/memobase/api/v1/`

认证方式：`Authorization: Bearer {YOUR_API_KEY}`

价格：限时免费

### 2.2 核心 API 列表

#### 用户管理

| API | 方法 | 路径 | 描述 |
|-----|------|------|------|
| Create User | POST | `/memobase/api/v1/users` | 创建新用户 |
| Get User | GET | `/memobase/api/v1/users/{user_id}` | 获取用户信息 |
| Update User | PUT | `/memobase/api/v1/users/{user_id}` | 更新用户信息 |
| Delete User | DELETE | `/memobase/api/v1/users/{user_id}` | 删除用户 |

**Create User 请求体**:
```json
{
  "id": "6b530024-36d8-4f03-9fdd-874151xxxxxx",
  "data": {}
}
```

**响应**:
```json
{
  "data": { "id": "user-uuid" },
  "errno": 0,
  "errmsg": ""
}
```

#### 数据管理 (短期记忆)

| API | 方法 | 路径 | 描述 |
|-----|------|------|------|
| Insert Data | POST | `/memobase/api/v1/blobs/insert/{user_id}` | 插入短期记忆数据 |
| Get Datas | GET | `/memobase/api/v1/users/blobs/{user_id}/{blob_type}` | 获取数据列表 |
| Get Data | GET | `/memobase/api/v1/blobs/{user_id}/{blob_id}` | 获取单个数据 |
| Delete Data | DELETE | `/memobase/api/v1/blobs/{user_id}/{blob_id}` | 删除单个数据 |

**Insert Data 请求体**:
```json
{
  "blob_type": "chat",
  "blob_data": {
    "messages": [
      { "role": "user", "content": "你好啊 我叫XXX" },
      { "role": "assistant", "content": "你好！有什么可以帮助你的？" }
    ]
  }
}
```

**blob_type 可选值**: `chat`, `doc`, `image`, `code`, `transcript`

**响应**:
```json
{
  "data": {
    "id": "blob-uuid",
    "chat_results": []
  },
  "errno": 0,
  "errmsg": ""
}
```

#### 记忆管理 (长期记忆)

| API | 方法 | 路径 | 描述 |
|-----|------|------|------|
| Flush Buffer | POST | `/memobase/api/v1/users/buffer/{user_id}/{buffer_type}` | 将短期记忆转为长期记忆 |
| Get User Profile | GET | `/memobase/api/v1/users/profile/{user_id}` | 获取用户记忆 |
| Delete User Profile | DELETE | `/memobase/api/v1/users/profile/{user_id}/{profile_id}` | 删除用户记忆 |
| Add User Profile | POST | `/memobase/api/v1/users/profile/{user_id}` | 插入用户配置 |
| Update User Profile | PUT | `/memobase/api/v1/users/profile/{user_id}/{profile_id}` | 更新用户配置 |

**Flush Buffer 说明**: 此行为后端会自动触发，无需每次都手动触发

**Get User Profile 响应**:
```json
{
  "data": {
    "profiles": [
      {
        "id": "<string>",
        "content": "<string>",
        "created_at": "2023-11-07T05:31:56Z",
        "updated_at": "2023-11-07T05:31:56Z",
        "attributes": {}
      }
    ],
    "id": "user-uuid"
  },
  "errno": 0,
  "errmsg": "",
  "object": "user_profile"
}
```

#### 事件管理

| API | 方法 | 路径 | 描述 |
|-----|------|------|------|
| Get User Recent Events | GET | `/memobase/api/v1/users/events/{user_id}` | 获取用户事件 |
| Search Events | POST | `/memobase/api/v1/users/events/search/{user_id}` | 搜索事件 |
| Update User Event | PUT | `/memobase/api/v1/users/events/{user_id}/{event_id}` | 更新用户事件 |
| Delete User Event | DELETE | `/memobase/api/v1/users/events/{user_id}/{event_id}` | 删除用户事件 |

#### Prompt 上下文

| API | 方法 | 路径 | 描述 |
|-----|------|------|------|
| Get User Personalized Context | GET | `/memobase/api/v1/users/context/{user_id}` | 提取对应的用户提示词 |

**响应格式同 Get User Profile**，返回 profiles 数组，可直接注入到 system prompt 中。

---

## 3. 模块设计

### 3.1 新增模块

#### 3.1.1 `src/services/memobase.js` - Memobase 服务封装

**常量定义**:
- `GLOBAL_SPAM_USER_ID`: 固定值 (e.g., `"global_spam_patterns"`)，用于存储全局纠正规则。

核心方法：
- `insertGlobalCorrection(originalMsg, correctionResult, reason)`: 将纠正记录存储到全局池。
- `getGlobalContext()`: 获取全局通用规则（用于 Prompt 注入）。
- `recordCorrection(userId, ...)`: 在记录到用户个人的同时，调用全局记录方法。

核心方法：
- `isAvailable()`: 检查服务是否可用（通过创建用户测试）
- `createUser(userId, data)`: 创建用户 - POST `/memobase/api/v1/users`
- `getUser(userId)`: 获取用户信息 - GET `/memobase/api/v1/users/{user_id}`
- `insertChatBlob(userId, messages)`: 插入聊天数据 - POST `/memobase/api/v1/blobs/insert/{user_id}`
- `recordJudgment(userId, msg, judgment, env)`: 记录 AI 判定结果
- `recordCorrection(userId, originalMsg, originalJudgment, correction, env)`: 记录管理员纠正反馈
- `getUserContext(userId)`: 获取用户记忆上下文 - GET `/memobase/api/v1/users/context/{user_id}`
- `getUserProfile(userId)`: 获取用户记忆画像 - GET `/memobase/api/v1/users/profile/{user_id}`
- `flushBuffer(userId, bufferType)`: 触发 flush 操作 - POST `/memobase/api/v1/users/buffer/{user_id}/{buffer_type}`
- `apiCall(path, method, body)`: 通用 API 调用方法

#### 3.1.2 `src/security/aiMemoryPrompt.js` - 记忆增强提示词模板

在原有 AI 反骚扰提示词基础上，注入用户历史记忆上下文。

核心方法：
- `fillMemoryContextTemplate(template, variables)`: 填充模板变量
- `enhanceSystemPrompt(basePrompt, memoryContext)`: 构建增强系统提示词

### 3.2 修改模块

#### 3.2.1 `src/security/aiAntiHarassment.js` - 修改

新增导入：
- `import { createMemobaseService } from '../services/memobase.js'`
- `import { enhanceSystemPrompt } from './aiMemoryPrompt.js'`

`checkAiSpam()` 函数修改：
1. 在获取信任列表检查后，新增获取 Memobase 记忆上下文
2. 使用 `enhanceSystemPrompt()` 构建增强提示词
3. 调用 LLM API 时使用增强提示词
4. 异步记录判定结果到 Memobase

`handleAiSpamIntercept()` 函数修改：
- 管理员通知消息中添加纠正按钮（SPAM/CLEAN 两个按钮）

#### 3.2.2 `src/handlers/callback.js` - 新增纠正回调

新增 `handleAiCorrectionCallback()` 函数：
- 解析回调数据格式：`ai_correction:{userId}:{msgHash}:{correctResult}`
- `correctResult` 为 `CLEAN`（误判纠正）或 `SPAM`（漏判纠正）

**处理逻辑**：
1.  **全局存储 (核心)**：无论针对哪个用户的纠正，都必须调用 `memobase.insertGlobalCorrection(...)`，将经验存入全局池，供后续所有用户复用。
2.  **个人存储**：调用 `memobase.insertChatBlob(...)` 记录到当前用户的个人档案。
3.  **触发信任熔断 (仅漏判场景)**：如果纠正结果是 `SPAM`，重置该用户的信任度。
4.  发送确认通知。

**处理逻辑**：
1.  **通用逻辑**：无论结果如何，调用 Memobase `insertChatBlob` 记录纠正内容。
2.  **SPAM 纠正（漏判场景）特有逻辑**：
    - 触发**信任熔断**：立即更新 D1 数据库，将该用户 `consecutive_clean_count` 置为 0，`trust_status` 设为 'monitoring'。
    - 目的：强制该用户下次发消息重新进入 AI 检测，并让 AI 读取到刚存入的负面记忆。
    - 执行拦截操作（如拉黑用户）。
3.  **CLEAN 纠正（误判场景）特有逻辑**：
    - 解除拉黑状态（如有）。
4.  最后触发 flush 确保记忆生效，发送确认通知。

**两种纠正场景**：

| 场景 | AI 判定 | 实际情况 | 纠正结果 | 触发动作 |
|------|---------|----------|----------|----------|
| 误判 | SPAM | CLEAN | CLEAN | 解除拉黑，记录纠正 |
| 漏判 | CLEAN | SPAM | SPAM | 执行拉黑，记录纠正 |

**漏判场景的额外入口**：
- 管理员可在话题中通过 `/markspam` 命令或回复消息时点击"标记为垃圾信息"按钮触发
- 回调格式：`ai_correction:{userId}:{msgHash}:SPAM`

**两种纠正场景**：

| 场景 | AI 判定 | 实际情况 | 纠正结果 | 触发动作 |
|------|---------|----------|----------|----------|
| 误判 | SPAM | CLEAN | CLEAN | 解除拉黑，记录纠正 |
| 漏判 | CLEAN | SPAM | SPAM | 执行拉黑，记录纠正 |

**漏判场景的额外入口**：
- 管理员可在话题中通过 `/markspam` 命令或回复消息时点击"标记为垃圾信息"按钮触发
- 回调格式：`ai_correction:{userId}:{msgHash}:SPAM`

#### 3.2.3 `src/database/index.js` - 新增记忆相关表

新增表：
1. `memobase_flush_counter`: Memobase flush 计数器表
   - `user_id TEXT PRIMARY KEY`
   - `ts INTEGER NOT NULL`

2. `ai_corrections`: AI 纠正记录表（用于追踪纠正历史）
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `user_id TEXT NOT NULL`
   - `original_judgment TEXT NOT NULL`
   - `corrected_result TEXT NOT NULL`
   - `reason TEXT`
   - `corrected_by TEXT`
   - `ts INTEGER NOT NULL`

#### 3.2.4 `src/handlers/adminConfig.js` - 管理面板配置项

新增配置项：
- `enable_memobase`: 长期记忆总开关（默认 false）
- `memobase_api_key`: 302.AI API Key
- `memobase_timeout_ms`: Memobase API 超时时间（默认 3000ms）
- `ai_trust_threshold`: AI 信任阈值（默认为 5，即连续通过 5 次检测后免检，用于判断何时触发熔断的基准）

---

## 4. 数据流设计

### 4.1 AI 判定流程（全局泛化）

```
用户发送消息 (User B)
    |
    v
+-----------------+
|  AI 反骚扰检测   |
+--------+--------+
         |
         v
+-------------------------------------+
| 1. 获取全局记忆上下文 (泛化经验)     |
|    getGlobalContext()               |
|    GET /memobase/api/v1/users/      |
|         context/global_spam_patterns|
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 2. 获取特定用户上下文 (个人历史)     |
|    getUserContext(userId)           |
|    (可选，如不需要个人画像可省略)    |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 3. 构建增强系统提示词                |
|    注入 "全局纠正规则" + "个人历史"  |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 4. 调用 LLM API 判定                 |
|    AI 参考 A 用户的经验判定 B 用户   |
+-------------------------------------+
```

### 4.2/4.3 管理员纠正流程 (经验存入全局池)

无论是误判还是漏判，核心动作是 **存入全局池**：

```
管理员执行纠正 (误判/漏判)
    |
    v
+-------------------------------------+
| 1. 存入全局纠正池 (核心)            |
|    insertGlobalCorrection()         |
|    UserID: "global_spam_patterns"   |
|    内容: "原文->结果。特征: XXX"    |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 2. 存入用户个人档案 (辅助)          |
|    insertChatBlob(userId)           |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 3. 执行分支动作 (根据纠正类型)       |
|    [误判 CLEAN]:                     |
|      解除黑名单                      |
|      UPDATE users SET                |
|      is_blocked = 0                  |
|                                      |
|    [漏判 SPAM]:                      |
|      触发信任熔断                    |
|      UPDATE user_trust SET           |
|      count=0, status='monitoring'    |
+--------+----------------------------+
         |
         v
+-------------------------------------+
| 效果：                              |
| A 用户的纠正经验立即变为全局规则    |
| B 用户发消息时，AI 读取全局规则     |
| 直接命中特征，正确判定              |
+-------------------------------------+
```

---

## 5. 部署方案

### 5.1 302.AI Memobase 云服务

1. 注册 302.AI 账号：https://302.ai/
2. 获取 API Key（统一 Key，所有 API 共用）
3. API Key 格式：`sk-` 开头

### 5.2 Cloudflare Workers 环境变量

```bash
# Memobase 配置
wrangler secret put MEMOBASE_API_KEY    # 302.AI API Key

# 或在 wrangler.toml 中配置（非敏感变量）
[vars]
ENABLE_MEMOBASE = "true"
MEMOBASE_TIMEOUT_MS = "3000"
```

---

## 6. 错误处理与降级

### 6.1 降级策略

Memobase 服务不可用时的降级处理：
1. 捕获异常，记录错误日志
2. 使用空字符串作为 memoryContext
3. 继续执行 AI 检测（使用原始提示词）
4. 不阻塞消息处理流程

### 6.2 重试机制

异步记忆操作的重试：
- 最多重试 2 次
- 使用指数退避策略（1秒、2秒）
- 超过最大重试次数后记录错误日志并放弃

---

## 7. 性能优化

### 7.1 异步非阻塞设计

记忆存储操作异步执行，不阻塞消息处理：
- `recordJudgment()` 使用 Promise 链异步执行
- 成功/失败都记录日志便于调试

### 7.2 批量 Flush 策略

每 5 条消息触发一次 flush，减少 API 调用频率：
- 使用 `memobase_flush_counter` 表记录消息计数
- 达到阈值后触发 flush 并清空计数
- 注意：Memobase 后端会自动触发 flush，无需每次都手动调用

### 7.3 超时控制

所有 Memobase API 调用设置合理超时：
- 默认超时 3000ms
- 使用 AbortController 实现超时中断
- 在 finally 块中清理定时器

---

## 8. 测试策略

### 8.1 单元测试

测试场景：
1. Memobase 服务禁用时返回 false
2. API 调用失败时优雅降级
3. 增强提示词正确注入记忆上下文
4. 空记忆上下文时不修改原始提示词

### 8.2 集成测试

测试场景：
1. 完整的 AI 检测流程（含记忆检索）
2. 管理员纠正回调处理
3. Flush 触发机制
4. 降级策略验证

### 8.3 端到端测试

测试场景：
1. 用户发送消息 -> AI 判定 -> 记录记忆
2. 管理员纠正 -> 记忆更新 -> 下次判定参考纠正
3. Memobase 不可用时系统降级运行

---

## 9. 实施计划

### 阶段一：基础设施（1-2 天）
1. 注册 302.AI 账号并获取 API Key
2. 创建 `src/services/memobase.js` 服务封装
3. 创建 `src/security/aiMemoryPrompt.js` 提示词模板
4. 在 `src/database/index.js` 中新增记忆相关表

### 阶段二：核心功能（2-3 天）
1. 修改 `src/security/aiAntiHarassment.js` 集成 **全局记忆** 检索
2. 修改 `src/services/memobase.js` 实现 `insertGlobalCorrection` 逻辑
3. 实现判定结果异步存储
4. 修改管理员通知，添加纠正按钮

### 阶段三：纠正反馈（1-2 天）
1. 在 `src/handlers/callback.js` 中新增纠正回调处理
2. 实现纠正记录存储和 flush 触发
3. 添加确认通知

### 阶段四：管理面板（1 天）
1. 在 `src/handlers/adminConfig.js` 中新增 Memobase 配置项
2. 实现配置验证（连通性检测）

### 阶段五：测试与优化（2-3 天）
1. 编写单元测试
2. 集成测试验证
3. 性能测试与优化
4. 文档更新

---

## 10. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| Memobase 服务不稳定 | AI 记忆功能不可用 | 中 | fail-open 策略，降级为无记忆模式 |
| 记忆质量差（噪声多） | AI 判定准确率下降 | 中 | 设置记忆筛选机制，仅存储高置信度记录 |
| API 调用延迟过高 | 消息处理超时 | 低 | 设置合理超时时间，异步处理记忆操作 |
| 存储成本超预期 | 运营费用增加 | 低 | 目前限时免费，后续关注计费策略 |
| API Key 泄露 | 安全风险 | 低 | 使用 wrangler secret 存储，不暴露在前端 |
