# 权限检测功能 - 技术设计文档

## 1. 功能架构设计

### 1.1 整体架构

```
┌─────────────────────────────────────────────┐
│           管理面板 (adminConfig.js)          │
│  ┌─────────────────────────────────────┐    │
│  │  权限检测按钮                        │    │
│  └──────────────┬──────────────────────┘    │
└─────────────────┼───────────────────────────┘
                  │ callback: check_permissions
┌─────────────────▼───────────────────────────┐
│       权限检测服务 (services/permissionCheck.js)  │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Bot 权限检测   │  │ 群管理权限检测        │  │
│  │ - getMe      │  │ - getChat            │  │
│  │ - getMe      │  │ - getChatMember      │  │
│  └──────────────┘  │ - createForumTopic   │  │
│                    └──────────────────────┘  │
└─────────────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│         Telegram API (api/telegram.js)      │
│  ┌──────────────────────────────────────┐  │
│  │ api(token, method, body)             │  │
│  │ - 重试退避机制                        │  │
│  │ - 超时处理                            │  │
│  └──────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 1.2 模块划分

| 模块 | 文件 | 职责 |
|------|------|------|
| UI 入口 | `src/handlers/adminConfig.js` | 管理面板按钮和回调处理 |
| 检测服务 | `src/services/permissionCheck.js` | 权限检测核心逻辑 |
| API 封装 | `src/api/telegram.js` | Telegram API 调用（已存在） |
| 辅助函数 | `src/utils/helpers.js` | 错误格式化等辅助函数 |

## 2. 权限检测逻辑

### 2.1 Bot 自身权限检测

```javascript
/**
 * 检测 Bot 自身权限
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} 检测结果
 */
async function checkBotPermissions(env) {
  const result = {
    botTokenValid: false,
    botInfo: null,
    canSetCommands: false,
    canSendMessage: false,
    errors: []
  };

  // 1. 检查 BOT_TOKEN 是否配置
  if (!env.BOT_TOKEN) {
    result.errors.push("BOT_TOKEN 未配置");
    return result;
  }

  // 2. 调用 getMe 验证 Token 有效性
  try {
    const botInfo = await api(env.BOT_TOKEN, "getMe", {});
    result.botTokenValid = true;
    result.botInfo = {
      id: botInfo.id,
      username: botInfo.username,
      firstName: botInfo.first_name
    };

    // 3. 尝试设置命令（验证 setMyCommands 权限）
    try {
      await api(env.BOT_TOKEN, "getMyCommands", {});
      result.canSetCommands = true;
    } catch (e) {
      result.errors.push(`命令权限受限：${e.message}`);
    }

    // 4. 验证消息发送权限（向 Bot 自身发送测试消息）
    try {
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: botInfo.id,
        text: "Permission check"
      });
      result.canSendMessage = true;
    } catch (e) {
      result.errors.push(`消息发送权限受限：${e.message}`);
    }
  } catch (e) {
    result.errors.push(`Bot Token 无效：${e.message}`);
  }

  return result;
}
```

### 2.2 群管理权限检测

```javascript
/**
 * 检测群管理权限
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} 检测结果
 */
async function checkGroupPermissions(env) {
  const result = {
    adminGroupIdConfigured: false,
    isBotAdmin: false,
    canCreateTopics: false,
    canSendMessages: false,
    canPinMessages: false,
    errors: []
  };

  // 1. 检查 ADMIN_GROUP_ID 是否配置
  if (!env.ADMIN_GROUP_ID) {
    result.errors.push("ADMIN_GROUP_ID 未配置");
    return result;
  }

  result.adminGroupIdConfigured = true;
  const chatId = env.ADMIN_GROUP_ID;

  // 2. 获取群组信息
  try {
    const chat = await api(env.BOT_TOKEN, "getChat", { chat_id: chatId });
    
    // 3. 检查 Bot 是否为管理员
    try {
      const member = await api(env.BOT_TOKEN, "getChatMember", {
        chat_id: chatId,
        user_id: (await api(env.BOT_TOKEN, "getMe", {})).id
      });
      
      if (member.status === "administrator" || member.status === "creator") {
        result.isBotAdmin = true;
        
        // 4. 检查具体权限
        result.canCreateTopics = !!chat.is_forum || member.can_manage_topics;
        result.canSendMessages = member.can_send_messages || member.can_post_messages;
        result.canPinMessages = member.can_pin_messages;
      } else {
        result.errors.push("Bot 不是管理群组的管理员");
      }
    } catch (e) {
      result.errors.push(`管理员身份验证失败：${e.message}`);
    }
  } catch (e) {
    result.errors.push(`群组访问失败：${e.message}`);
  }

  return result;
}
```

### 2.3 综合检测入口

```javascript
/**
 * 综合权限检测
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} 完整检测结果
 */
export async function checkAllPermissions(env) {
  const [botResult, groupResult] = await Promise.allSettled([
    checkBotPermissions(env),
    checkGroupPermissions(env)
  ]);

  return {
    bot: botResult.status === "fulfilled" ? botResult.value : { error: botResult.reason?.message },
    group: groupResult.status === "fulfilled" ? groupResult.value : { error: groupResult.reason?.message },
    timestamp: Date.now()
  };
}
```

## 3. UI 交互设计

### 3.1 管理面板入口

在现有控制面板中增加"权限检测"按钮：

```javascript
// src/handlers/adminConfig.js
if (key === "perms") {
  const t = (v) => v ? "✅" : "❌";
  
  return render(`🔐 <b>权限检测</b>

<b>Bot 权限</b>
Token 有效：${t(result.bot.botTokenValid)}
Bot: ${result.bot.botInfo?.username || "未知"}
命令权限：${t(result.bot.canSetCommands)}
消息权限：${t(result.bot.canSendMessage)}

<b>群管理权限</b>
群组配置：${t(result.group.adminGroupIdConfigured)}
管理员身份：${t(result.group.isBotAdmin)}
话题权限：${t(result.group.canCreateTopics)}
消息权限：${t(result.group.canSendMessages)}
置顶权限：${t(result.group.canPinMessages)}

${result.bot.errors.length > 0 || result.group.errors.length > 0 ? 
  "<b>⚠️ 问题</b>:\n" + 
  [...result.bot.errors, ...result.group.errors].map(e => `• ${e}`).join("\n") +
  "\n\n请根据提示修复后重新检测" : 
  "✅ 所有权限检测通过"}, {
    inline_keyboard: [
      [{ text: "🔄 重新检测", callback_data: "config:check:perms" }],
      [back]
    ]
  });
}
```

### 3.2 控制面板菜单修改

```javascript
// 在控制面板主菜单增加权限检测入口
{ inline_keyboard: [
  [{ text: "📝 基础", callback_data: "config:menu:base" }, { text: "🤖 自动回复", callback_data: "config:menu:ar" }],
  [{ text: "🚫 屏蔽词", callback_data: "config:menu:kw" }, { text: "🛠 过滤", callback_data: "config:menu:fl" }],
  [{ text: "👮 协管", callback_data: "config:menu:auth" }, { text: "💾 备份/通知", callback_data: "config:menu:bak" }],
  [{ text: "🌙 营业状态", callback_data: "config:menu:busy" }, { text: "🛡 反骚扰", callback_data: "config:menu:ah" }],
  [{ text: "🤖 AI 反骚扰", callback_data: "config:menu:aiah" }],
  [{ text: "🔐 权限检测", callback_data: "config:check:perms" }]  // 新增
]}
```

### 3.3 检测中状态

```javascript
// 点击按钮后立即返回 Loading 状态
render(`🔐 <b>权限检测中</b>\n\n正在检查各项权限...\n请稍候`, {
  inline_keyboard: [
    [{ text: "⏳ 检测中...", callback_data: "config:check:perms_loading" }]
  ]
});

// 后台执行检测，完成后编辑消息
```

### 3.4 错误提示 UI

```javascript
// Bot Token 无效
render(`❌ <b>权限检测失败</b>\n\n<b>Bot Token 无效</b>\n\n原因：${errorMessage}\n\n<b>解决方案</b>:\n1. 检查 Cloudflare 环境变量 BOT_TOKEN\n2. 确认 Token 格式正确（以数字：开头）\n3. 联系 @BotFather 重新获取 Token`, {
  inline_keyboard: [[{ text: "🔄 重新检测", callback_data: "config:check:perms" }]]
});

// 非管理员
render(`⚠️ <b>权限不足</b>\n\nBot 不是管理群组的管理员\n\n<b>解决方案</b>:\n1. 进入管理群组\n2. 群组设置 → 管理员 → 添加管理员\n3. 选择本 Bot\n4. 授予"管理员"权限`, {
  inline_keyboard: [[{ text: "🔄 重新检测", callback_data: "config:check:perms" }]]
});
```

## 4. 数据结构设计

### 4.1 检测结果结构

```javascript
{
  // Bot 权限检测结果
  bot: {
    botTokenValid: boolean,      // Token 是否有效
    botInfo: {                   // Bot 基本信息
      id: number,
      username: string,
      firstName: string
    } | null,
    canSetCommands: boolean,     // 能否设置命令
    canSendMessage: boolean,     // 能否发送消息
    errors: string[]             // 错误列表
  },
  
  // 群管理权限检测结果
  group: {
    adminGroupIdConfigured: boolean,  // ADMIN_GROUP_ID 是否配置
    isBotAdmin: boolean,              // Bot 是否为管理员
    canCreateTopics: boolean,         // 能否创建话题
    canSendMessages: boolean,         // 能否发送消息
    canPinMessages: boolean,          // 能否置顶消息
    errors: string[]                  // 错误列表
  },
  
  timestamp: number  // 检测时间戳
}
```

### 4.2 权限项定义

```javascript
const PERMISSION_ITEMS = [
  {
    key: "botTokenValid",
    label: "Bot Token",
    category: "bot",
    fixGuide: "在 Cloudflare 环境变量中配置 BOT_TOKEN"
  },
  {
    key: "isBotAdmin",
    label: "管理员身份",
    category: "group",
    fixGuide: "将 Bot 添加为管理群组的管理员"
  },
  {
    key: "canCreateTopics",
    label: "话题创建",
    category: "group",
    fixGuide: "授予 Bot"创建话题"权限"
  },
  {
    key: "canSendMessages",
    label: "消息发送",
    category: "group",
    fixGuide: "授予 Bot"发送消息"权限"
  },
  {
    key: "canPinMessages",
    label: "消息置顶",
    category: "group",
    fixGuide: "授予 Bot"置顶消息"权限"
  }
];
```

## 5. 实现步骤

### 5.1 第一步：创建权限检测服务

创建文件 `src/services/permissionCheck.js`:

```javascript
/**
 * 权限检测服务
 */

import { api } from '../api/telegram.js';

/**
 * 检测 Bot 自身权限
 */
async function checkBotPermissions(env) {
  // 实现见 2.1 节
}

/**
 * 检测群管理权限
 */
async function checkGroupPermissions(env) {
  // 实现见 2.2 节
}

/**
 * 综合权限检测
 */
export async function checkAllPermissions(env) {
  // 实现见 2.3 节
}

/**
 * 格式化检测报告为 HTML
 */
export function formatPermissionReport(result) {
  const t = (v) => v ? "✅" : "❌";
  
  let html = `🔐 <b>权限检测报告</b>\n\n`;
  
  // Bot 权限
  html += `<b>Bot 权限</b>\n`;
  html += `Token 有效：${t(result.bot.botTokenValid)}\n`;
  if (result.bot.botInfo) {
    html += `Bot: @${result.bot.botInfo.username}\n`;
  }
  html += `命令权限：${t(result.bot.canSetCommands)}\n`;
  html += `消息权限：${t(result.bot.canSendMessage)}\n`;
  
  // 群管理权限
  html += `\n<b>群管理权限</b>\n`;
  html += `群组配置：${t(result.group.adminGroupIdConfigured)}\n`;
  html += `管理员身份：${t(result.group.isBotAdmin)}\n`;
  html += `话题权限：${t(result.group.canCreateTopics)}\n`;
  html += `消息权限：${t(result.group.canSendMessages)}\n`;
  html += `置顶权限：${t(result.group.canPinMessages)}\n`;
  
  // 错误信息
  const errors = [...(result.bot.errors || []), ...(result.group.errors || [])];
  if (errors.length > 0) {
    html += `\n<b>⚠️ 问题</b>:\n`;
    html += errors.map(e => `• ${e}`).join('\n');
    html += `\n\n请根据提示修复后重新检测`;
  } else {
    html += `\n✅ 所有权限检测通过`;
  }
  
  return html;
}
```

### 5.2 第二步：修改管理面板

编辑 `src/handlers/adminConfig.js`:

1. 导入权限检测服务：

```javascript
import { checkAllPermissions, formatPermissionReport } from '../services/permissionCheck.js';
```

2. 在主菜单添加权限检测入口：

```javascript
if (!key)
  return render("⚙️ <b>控制面板</b>", {
    inline_keyboard: [
      [{ text: "📝 基础", callback_data: "config:menu:base" }, { text: "🤖 自动回复", callback_data: "config:menu:ar" }],
      [{ text: "🚫 屏蔽词", callback_data: "config:menu:kw" }, { text: "🛠 过滤", callback_data: "config:menu:fl" }],
      [{ text: "👮 协管", callback_data: "config:menu:auth" }, { text: "💾 备份/通知", callback_data: "config:menu:bak" }],
      [{ text: "🌙 营业状态", callback_data: "config:menu:busy" }, { text: "🛡 反骚扰", callback_data: "config:menu:ah" }],
      [{ text: "🤖 AI 反骚扰", callback_data: "config:menu:aiah" }],
      [{ text: "🔐 权限检测", callback_data: "config:check:perms" }]  // 新增
    ]
  });
```

3. 添加权限检测处理逻辑：

```javascript
if (type === "check" && key === "perms") {
  // 先返回 Loading 状态
  const loadingMsg = await render(`🔐 <b>权限检测中</b>\n\n正在检查各项权限...\n请稍候`, {
    inline_keyboard: [[{ text: "⏳ 检测中...", callback_data: "config:check:perms_loading" }]]
  });

  // 后台执行检测
  try {
    const result = await checkAllPermissions(env);
    const reportHtml = formatPermissionReport(result);
    
    // 编辑消息为检测报告
    await api(env.BOT_TOKEN, "editMessageText", {
      chat_id: cid,
      message_id: loadingMsg.result.message_id,
      text: reportHtml,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 重新检测", callback_data: "config:check:perms" }],
          [{ text: "🔙 返回", callback_data: "config:menu" }]
        ]
      }
    });
  } catch (e) {
    await api(env.BOT_TOKEN, "editMessageText", {
      chat_id: cid,
      message_id: loadingMsg.result.message_id,
      text: `❌ <b>检测失败</b>\n\n错误信息：${escapeHTML(e.message)}\n\n请重试`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 重新检测", callback_data: "config:check:perms" }],
          [{ text: "🔙 返回", callback_data: "config:menu" }]
        ]
      }
    });
  }
  
  return;  // 已异步处理，不返回 render 结果
}
```

### 5.3 第三步：添加管理员命令（可选）

在 `src/api/commands.js` 中添加命令：

```javascript
// 在 setMyCommands 中增加权限检测命令
{ command: "checkperms", description: "检测 Bot 权限状态" }
```

在 `src/handlers/private.js` 或相应处理器中添加命令响应：

```javascript
if (cmd === "/checkperms" || cmd === "/check_permissions") {
  const result = await checkAllPermissions(env);
  const reportHtml = formatPermissionReport(result);
  
  await api(env.BOT_TOKEN, "sendMessage", {
    chat_id: msg.from.id,
    text: reportHtml,
    parse_mode: "HTML"
  });
  return;
}
```

### 5.4 第四步：错误处理增强

在 `src/utils/helpers.js` 中添加错误格式化函数：

```javascript
/**
 * 格式化 Telegram API 错误为友好提示
 */
export function formatTelegramError(error, context) {
  const msg = error.message || String(error);
  
  if (msg.includes("Unauthorized")) {
    return "Bot Token 无效或已过期";
  }
  if (msg.includes("Forbidden")) {
    if (context === "group") {
      return "Bot 不是群组管理员";
    }
    return "权限不足";
  }
  if (msg.includes("chat not found")) {
    return "群组不存在或 Bot 已被移除";
  }
  if (msg.includes("timeout")) {
    return "请求超时，请检查网络连接";
  }
  
  return msg;
}
```

### 5.5 第五步：测试验证

1. **单元测试**：
   - 测试 Bot Token 无效场景
   - 测试 ADMIN_GROUP_ID 未配置场景
   - 测试 Bot 非管理员场景
   - 测试所有权限正常场景

2. **集成测试**：
   - 在真实群组中测试完整检测流程
   - 测试并发检测（多个管理员同时点击）
   - 测试网络异常情况下的错误提示

3. **UI 测试**：
   - 验证 Loading 状态显示
   - 验证检测报告格式
   - 验证重新检测功能

## 6. 依赖关系

### 6.1 已有依赖

| 依赖 | 文件 | 说明 |
|------|------|------|
| api | `src/api/telegram.js` | Telegram API 调用 |
| helpers | `src/utils/helpers.js` | 辅助函数 |
| adminConfig | `src/handlers/adminConfig.js` | 管理面板 |

### 6.2 新增文件

| 文件 | 说明 |
|------|------|
| `src/services/permissionCheck.js` | 权限检测服务 |

## 7. 环境变量

### 7.1 必需环境变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | `123456789:ABCdefGHIjklMNOpqrsTUVwxyz` |
| `ADMIN_GROUP_ID` | 管理群组 ID | `-1001234567890` |

### 7.2 可选环境变量

无需新增环境变量。

## 8. 性能优化

### 8.1 并行检测

使用 `Promise.allSettled` 并行执行 Bot 权限和群管理权限检测：

```javascript
const [botResult, groupResult] = await Promise.allSettled([
  checkBotPermissions(env),
  checkGroupPermissions(env)
]);
```

### 8.2 API 调用超时

在 `api/telegram.js` 中已有超时控制，无需额外修改。

### 8.3 结果不缓存

每次点击检测按钮都实时检测，确保结果准确性。

## 9. 安全性

### 9.1 管理员鉴权

权限检测功能仅在管理面板中可用，已有管理员鉴权机制保护。

### 9.2 敏感信息保护

检测结果中不展示完整的 Bot Token，仅显示 Bot 用户名和 ID。

### 9.3 只读操作

权限检测仅读取权限状态，不修改任何配置或权限。

## 10. 维护指南

### 10.1 新增权限检测项

在 `checkBotPermissions` 或 `checkGroupPermissions` 中增加检测逻辑：

```javascript
// 新增检测项
result.canInviteUsers = member.can_invite_users;

// 在 UI 中展示
html += `邀请权限：${t(result.canInviteUsers)}\n`;
```

### 10.2 错误码扩展

在 `formatTelegramError` 中增加新的错误处理：

```javascript
if (msg.includes("new error code")) {
  return "新的错误提示";
}
```

### 10.3 UI 优化

根据用户反馈优化检测报告展示格式，增加更多可视化元素。
