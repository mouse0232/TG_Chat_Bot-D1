# 反骚扰功能 - 技术设计文档

## 1. 架构设计

### 1.1 模块位置

```
src/
├── security/
│   └── antiHarassment.js      # 反骚扰检测核心逻辑
├── handlers/
│   └── private.js             # 集成检测调用（修改）
├── services/
│   └── blacklist.js           # 复用现有黑名单服务
├── database/
│   └── config.js              # 新增配置项（修改）
└── utils/
    └── constants.js           # 新增默认配置（修改）
```

### 1.2 检测流程集成点

```
用户消息进入
    │
    ▼
┌─────────────────┐
│ router/index.js │
│ (现有路由)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ handlers/update │
│ (现有分发器)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ handlers/private│
│ (修改：集成检测)│
└────────┬────────┘
         │
    ┌────┴────────────────────────────┐
    │                                 │
    ▼                                 ▼
┌─────────────────┐           ┌─────────────────┐
│ antiHarassment  │           │ 现有验证流程    │
│ checkUser()     │           │                 │
└────────┬────────┘           └─────────────────┘
         │
         ▼
┌─────────────────┐
│ antiHarassment  │
│ checkMessage()  │
│ (仅已验证用户)  │
└─────────────────┘
```

## 2. 核心模块设计

### 2.1 `src/security/antiHarassment.js`

**职责**：反骚扰检测核心逻辑

**导出函数**：

```javascript
/**
 * 检测用户是否触发反骚扰规则
 * @param {Object} user - Telegram User 对象 (msg.from)
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { triggered: boolean, reason: string, rule: string }
 */
export async function checkUser(user, env) { ... }

/**
 * 检测消息是否触发反骚扰规则
 * @param {Object} msg - Telegram Message 对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { triggered: boolean, reason: string, rule: string }
 */
export async function checkMessage(msg, env) { ... }

/**
 * 处理拦截（用户身份检测）
 * 只提示，不拉黑
 * @param {string} userId - 用户 ID
 * @param {string} reason - 拦截原因
 * @param {Object} env - 环境变量
 */
export async function handleUserIntercept(userId, reason, env) { ... }

/**
 * 处理拦截（消息内容检测）
 * 提示并拉黑
 * @param {string} userId - 用户 ID
 * @param {Object} userInfo - Telegram User 对象
 * @param {string} reason - 拦截原因
 * @param {Object} env - 环境变量
 */
export async function handleMessageIntercept(userId, userInfo, reason, env) { ... }
```

**检测规则实现**：

```javascript
// 用户身份检测规则
const USER_RULES = [
  {
    name: "premium_user",
    config: "anti_harassment_allow_premium",
    check: (user) => user.is_premium === true,
    action: "allow",
    priority: 100
  },
  {
    name: "bot_account",
    config: "anti_harassment_block_bot",
    check: (user) => user.is_bot === true,
    action: "intercept",
    reason: "机器人账号",
    priority: 90
  },
  {
    name: "no_username",
    config: "anti_harassment_block_no_username",
    check: (user) => !user.username,
    action: "intercept",
    reason: "未设置用户名",
    priority: 80
  }
];

// 消息内容检测规则
const MESSAGE_RULES = [
  {
    name: "bot_forward",
    config: "anti_harassment_block_bot_forward",
    check: (msg) => msg.forward_from?.is_bot === true,
    action: "intercept",
    reason: "转发机器人消息",
    priority: 90
  },
  {
    name: "inline_keyboard",
    config: "anti_harassment_block_inline_keyboard",
    check: (msg) => msg.reply_markup?.inline_keyboard?.length > 0,
    action: "intercept",
    reason: "包含内联键盘",
    priority: 80
  },
  {
    name: "mention",
    config: "anti_harassment_block_mention",
    check: (msg) => (msg.entities || []).some(e => e.type === "mention" || e.type === "text_mention"),
    action: "intercept",
    reason: "包含@提及",
    priority: 70
  }
];
```

### 2.2 `src/handlers/private.js` 修改

**修改点 1**：用户进入时检测（`handlePrivate` 函数开头）

```javascript
export async function handlePrivate(msg, env, ctx) {
  const id = msg.chat.id.toString();
  const text = msg.text || "";
  const isStart = text.startsWith("/start");

  // 先取用户，保证 block 生效是 DB 真实状态
  const u0 = await getUser(id, env);
  
  // ===== 反骚扰用户检测（新增）=====
  const antiHarassment = await import('../security/antiHarassment.js');
  
  // 用户身份检测（所有用户）
  const userCheck = await antiHarassment.checkUser(msg.from, env);
  if (userCheck.triggered) {
    // 用户身份检测触发：只提示，不拉黑
    await antiHarassment.handleUserIntercept(id, userCheck.reason, env);
    return;
  }
  // ===== 反骚扰用户检测结束 =====
  
  // 原有逻辑继续：屏蔽检查、限流、验证流程...
```

**修改点 2**：已验证用户消息检测（`handleVerifiedMsg` 函数开头）

```javascript
async function handleVerifiedMsg(msg, u, env, ctx) {
  const id = u.user_id;

  // 保险：若中途被屏蔽（并发情况下），直接终止
  if (u.is_blocked && !(await isAuthAdmin(id, env))) return;

  // ===== 反骚扰消息检测（新增）=====
  const antiHarassment = await import('../security/antiHarassment.js');
  const msgCheck = await antiHarassment.checkMessage(msg, env);
  if (msgCheck.triggered) {
    // 消息检测触发：提示并拉黑
    await antiHarassment.handleMessageIntercept(id, msg.from, msgCheck.reason, env);
    return;
  }
  // ===== 反骚扰消息检测结束 =====

  // 原有逻辑继续：屏蔽词检测、类型过滤、转发...
```

### 2.3 `src/utils/constants.js` 修改

**新增默认配置**：

```javascript
export const DEFAULTS = {
  // ... 现有配置 ...
  
  // 反骚扰功能
  enable_anti_harassment: "true",
  anti_harassment_block_bot: "true",
  anti_harassment_block_no_username: "true",
  anti_harassment_allow_premium: "true",
  anti_harassment_block_bot_forward: "true",
  anti_harassment_block_inline_keyboard: "true",
  anti_harassment_block_mention: "true"
};
```

### 2.4 `src/database/index.js` 修改

**数据库表无需修改**，复用现有 `users` 表的 `is_blocked` 字段和 `user_info_json` 字段。

## 3. 接口设计

### 3.1 Telegram Bot API 依赖

本功能完全基于 Telegram Bot API 返回的数据结构：

**User 对象字段**：
- `is_bot` (Boolean): 是否为机器人
- `username` (String): 用户名（可选）
- `is_premium` (Boolean): 是否为 Premium 用户（可选）

**Message 对象字段**：
- `forward_from` (User): 转发来源用户
- `reply_markup` (InlineKeyboardMarkup): 内联键盘
- `reply_markup.inline_keyboard` (Array): 键盘按钮数组

### 3.2 内部接口

```javascript
// antiHarassment.js 对外接口

/**
 * 检测结果
 * @typedef {Object} CheckResult
 * @property {boolean} triggered - 是否触发规则
 * @property {string} [reason] - 触发原因描述
 * @property {string} [rule] - 触发的规则名称
 */

/**
 * 检测用户
 * @param {Object} user - Telegram User 对象
 * @param {Object} env - 环境变量
 * @returns {Promise<CheckResult>}
 */
async function checkUser(user, env)

/**
 * 检测消息
 * @param {Object} msg - Telegram Message 对象
 * @param {Object} env - 环境变量
 * @returns {Promise<CheckResult>}
 */
async function checkMessage(msg, env)

/**
 * 处理用户身份拦截（只提示，不拉黑）
 * @param {string} userId - 用户 ID
 * @param {string} reason - 拦截原因
 * @param {Object} env - 环境变量
 * @returns {Promise<void>}
 */
async function handleUserIntercept(userId, reason, env)

/**
 * 处理消息内容拦截（提示并拉黑）
 * @param {string} userId - 用户 ID
 * @param {Object} userInfo - Telegram User 对象
 * @param {string} reason - 拦截原因
 * @param {Object} env - 环境变量
 * @returns {Promise<void>}
 */
async function handleMessageIntercept(userId, userInfo, reason, env)
```

## 4. 数据流设计

### 4.1 用户身份检测数据流

```
msg.from (Telegram User)
    │
    ▼
┌─────────────────┐
│ checkUser()     │
│                 │
│ 1. 读取配置     │
│ 2. 按优先级检测 │
│ 3. 返回结果     │
└────────┬────────┘
         │
    ┌────┴────────────┐
    ▼                 ▼
┌──────────┐   ┌──────────────┐
│ 通过      │   │ 触发规则      │
└───┬──────┘   └──────┬───────┘
    │                 │
    ▼                 ▼
┌──────────┐   ┌──────────────────────┐
│ 继续流程  │   │ handleUserIntercept()│
│ (验证等)  │   │                      │
└──────────┘   │ 1. 发送提示消息      │
               │ 2. 不拉黑            │
               └──────────────────────┘
```

### 4.2 消息内容检测数据流

```
msg (Telegram Message)
    │
    ▼
┌─────────────────┐
│ checkMessage()  │
│                 │
│ 1. 读取配置     │
│ 2. 检测消息结构 │
│ 3. 返回结果     │
└────────┬────────┘
         │
    ┌────┴────────────────────┐
    ▼                         ▼
┌──────────┐           ┌──────────────┐
│ 通过      │           │ 触发规则      │
└───┬──────┘           └──────┬───────┘
    │                         │
    ▼                         ▼
┌──────────┐           ┌──────────────────────────┐
│ 转发消息  │           │ handleMessageIntercept() │
│          │           │                          │
└──────────┘           │ 1. 发送提示消息          │
                       │ 2. 设置 is_blocked=true  │
                       │ 3. 调用 manageBlacklist()│
                       │ 4. 通知管理员            │
                       └──────────────────────────┘
```

## 5. 错误处理

### 5.1 检测失败处理

```javascript
try {
  const result = await checkUser(user, env);
  if (result.triggered) {
    await handleUserIntercept(userId, result.reason, env);
    return;
  }
} catch (error) {
  console.error("Anti-harassment check failed:", error);
  // 检测失败时不阻断流程，允许消息通过
  // 记录错误日志供排查
}
```

### 5.2 拦截处理失败

```javascript
try {
  await handleUserIntercept(userId, reason, env);
} catch (error) {
  console.error("Anti-harassment intercept failed:", error);
  // 拦截失败时：
  // 1. 记录错误日志
  // 2. 不抛出异常，避免影响其他流程
}
```

## 6. 性能考虑

### 6.1 检测性能

- 所有检测均为同步判断，无需异步操作
- 配置读取使用现有缓存机制（60秒 TTL）
- 检测逻辑时间复杂度：O(1)

### 6.2 优化策略

```javascript
// 配置缓存（复用现有 cache.js）
const configCache = new Map();

async function getAntiHarassmentConfig(key, env) {
  const cacheKey = `anti_harassment:${key}`;
  if (configCache.has(cacheKey)) {
    return configCache.get(cacheKey);
  }
  const value = await getBoolConfig(key, env);
  configCache.set(cacheKey, value);
  return value;
}
```

## 7. 安全考虑

### 7.1 防止误拦截

- Premium 用户白名单机制
- 管理员不受检测影响（现有 `isAuthAdmin` 检查）
- 配置项可独立开关各项规则

### 7.2 防止绕过

- 用户身份检测在验证流程之前执行
- 已验证用户发送消息时再次检测
- 使用 `msg.from` 而非缓存的用户信息（防止信息伪造）

## 8. 测试策略

### 8.1 单元测试

```javascript
// checkUser 测试用例
describe("checkUser", () => {
  test("机器人账号被拦截", async () => {
    const user = { id: "123", is_bot: true };
    const result = await checkUser(user, env);
    expect(result.triggered).toBe(true);
    expect(result.rule).toBe("bot_account");
  });

  test("空用户名被拦截", async () => {
    const user = { id: "123", username: null };
    const result = await checkUser(user, env);
    expect(result.triggered).toBe(true);
    expect(result.rule).toBe("no_username");
  });

  test("Premium 用户放行", async () => {
    const user = { id: "123", is_premium: true, is_bot: true };
    const result = await checkUser(user, env);
    expect(result.triggered).toBe(false);
  });
});

// handleUserIntercept 测试用例
describe("handleUserIntercept", () => {
  test("只提示，不拉黑", async () => {
    await handleUserIntercept("123", "机器人账号", env);
    // 验证：
    // 1. 发送了提示消息
    // 2. 未调用 updateUser({ is_blocked: true })
    // 3. 未调用 manageBlacklist()
  });
});

// handleMessageIntercept 测试用例
describe("handleMessageIntercept", () => {
  test("提示并拉黑", async () => {
    await handleMessageIntercept("123", { id: "123" }, "转发机器人消息", env);
    // 验证：
    // 1. 发送了提示消息
    // 2. 调用了 updateUser({ is_blocked: true })
    // 3. 调用了 manageBlacklist()
  });
});
```

### 8.2 集成测试

- 测试完整消息流程：用户发送消息 -> 检测 -> 拦截/通过
- 测试配置开关：关闭功能后不应触发检测
- 测试与现有功能兼容性：验证流程、黑名单、管理面板

## 9. 部署影响

### 9.1 文件变更清单

**新增文件**：
- `src/security/antiHarassment.js`

**修改文件**：
- `src/handlers/private.js`（集成检测调用）
- `src/utils/constants.js`（新增默认配置）

**无需修改**：
- 数据库表结构（复用现有字段）
- 路由层
- API 层
- 其他服务层

### 9.2 配置迁移

首次部署时，配置项会自动使用默认值（`DEFAULTS` 中定义）。

### 9.3 回滚策略

- 删除 `src/security/antiHarassment.js`
- 恢复 `src/handlers/private.js` 到修改前版本
- 恢复 `src/utils/constants.js` 到修改前版本

## 10. 监控与日志

### 10.1 关键日志

```javascript
// 检测触发日志
console.log(`[AntiHarassment] User ${userId} triggered rule: ${rule} (${reason})`);

// 用户身份拦截日志
console.log(`[AntiHarassment] User ${userId} intercepted (user). Reason: ${reason}`);

// 消息内容拦截日志
console.log(`[AntiHarassment] User ${userId} intercepted (message). Reason: ${reason}`);

// 检测失败日志
console.error(`[AntiHarassment] Check failed for user ${userId}:`, error);
```

### 10.2 监控指标

- 检测触发次数（按规则分类）
- 用户身份拦截数（不拉黑）
- 消息内容拦截数（拉黑）
- 检测耗时
- 检测失败次数
