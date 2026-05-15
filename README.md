# Telegram 双向机器人 Cloudflare Worker v4.0

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-FFC425?logo=cloudflare)](https://workers.cloudflare.com/)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-3AB3E0?logo=telegram)](https://core.telegram.org/bots/api)
[![D1 Database](https://img.shields.io/badge/D1-Database-FFC425?logo=cloudflare)](https://developers.cloudflare.com/d1)

> **企业级私聊托管与风控解决方案** - 基于 Cloudflare Worker + D1 数据库构建的高性能 Telegram 双向机器人，采用模块化架构设计，支持三模态验证、可视化协管系统和智能 CRM 管理

---

## 版本更新

### v4.0 重大重构
- **模块化架构**：从单体 1735 行文件重构为 35 个模块，按 7 层架构组织
- **可维护性提升**：每个模块职责单一，代码量控制在 200 行以内
- **可扩展性增强**：新增功能无需修改现有代码，支持插件化扩展
- **部署方式升级**：支持 Cloudflare 后台关联 Git 仓库自动部署

---

## 项目架构

```
src/
├── index.js                 # Worker 入口
├── router/
│   └── index.js             # HTTP 路由分发
├── handlers/                # 业务处理器（8 个模块）
│   ├── update.js            # Update 主分发器
│   ├── private.js           # 私聊处理
│   ├── adminReply.js        # 管理员回复
│   ├── callback.js          # 回调处理
│   ├── edit.js              # 编辑消息
│   ├── verifyPage.js        # 验证页面
│   ├── tokenSubmit.js       # Token 提交
│   └── adminConfig.js       # 管理面板
├── services/                # 核心服务（7 个模块）
│   ├── relay.js             # 消息转发（含分布式锁）
│   ├── topic.js             # 话题管理
│   ├── inbox.js             # 未读通知
│   ├── blacklist.js         # 黑名单
│   ├── backup.js            # 备份
│   ├── infoCard.js          # 资料卡
│   └── verification.js      # 验证服务
├── security/                # 安全层（9 个模块）
│   ├── webhook.js           # Webhook 校验
│   ├── rateLimit.js          # 限流
│   ├── idempotency.js        # 幂等去重
│   ├── initData.js           # initData 验签
│   ├── regexGuard.js         # ReDoS 防护
│   ├── cleanup.js            # TTL 清理
│   ├── antiHarassment.js     # 本地反骚扰检测
│   ├── aiAntiHarassment.js   # AI 反骚扰检测
│   └── aiSpamPrompt.js       # LLM 提示词模板
├── database/                # 数据层（7 个模块）
│   ├── index.js              # DB 初始化
│   ├── config.js             # 配置操作
│   ├── users.js              # 用户操作
│   ├── messages.js           # 消息操作
│   ├── updates.js            # Update 记录
│   ├── rateLimits.js          # 限流记录
│   └── trust.js              # AI 信任数据
├── api/                     # API 层（2 个模块）
│   ├── telegram.js          # TG API 封装
│   └── commands.js          # 命令管理
└── utils/                   # 工具层（4 个模块）
    ├── constants.js         # 常量定义
    ├── helpers.js           # 辅助函数
    ├── cache.js             # 缓存管理
    └── templates.js         # HTML 模板
```

---

## 核心功能

### 1. 多维安全验证系统
- **三模态一键切换**：Cloudflare Turnstile、Google Recaptcha、关闭验证模式
- **独立问答验证**：支持自定义问答拦截基础脚本攻击
- **组合防御**：支持"验证码 + 问答"双重验证

### 2. 协管权限系统
- **权限下放**：主管理员可添加多名协管员
- **可视化管理**：直观展示所有协管 ID，支持精准删除与添加

### 3. 双向消息中继
- **自动话题**：每个用户私聊消息自动创建独立话题（Topic）
- **无感回复**：管理员在话题内直接回复，机器人自动转发给用户

### 4. CRM 客户管理系统
- **智能备注**：管理员点击资料卡按钮为用户打标签
- **全局同步**：修改备注后所有历史资料卡自动同步更新
- **资料卡追踪**：话题顶部始终置顶最新用户资料卡

### 5. 聚合收件箱 (One Card Policy)
- **防刷屏机制**：每个用户只保留一张最新通知卡片
- **阅后即焚**：点击已阅/删除，卡片即刻消失
- **一键直达**：通知卡片包含跳转按钮直达用户话题

### 6. 黑名单隔离系统
- **双向同步**：手动屏蔽或触发关键词自动封禁
- **一键解封**：状态双向同步，黑名单卡片自动销毁

### 7. 营业状态管理
- **一键切换**："营业中"或"休息中"
- **自动回复**：休息模式下用户收到预设忙碌提示（内置防抖）

### 8. 安全防护
- **Webhook Secret 校验**：拒绝非 Telegram 请求
- **多层限流**：用户级、全局级、提交级限流
- **Update 幂等去重**：防止重复处理
- **ReDoS 防护**：正则表达式安全检测
- **TTL 自动清理**：过期数据自动清理
- **AI 反骚扰 fail-open**：LLM 不可用时放行消息，不误杀

### 9. 本地反骚扰检测
- **用户身份检测**：拦截机器人账号（is_bot）和空用户名用户，提示"不符合聊天对象"，不拉黑
- **Premium 白名单**：Telegram Premium 用户直接放行
- **消息内容检测**：拦截 Bot 转发消息、带内联键盘消息、包含 @提及（mention/text_mention）的消息，提示并拉黑
- **可配置开关**：每条检测规则可独立开关，总开关控制启用/禁用

### 10. AI 反骚扰检测
- **LLM 语义检测**：调用 OpenAI Compatible API 识别广告、诈骗、钓鱼等语义层面垃圾信息
- **AI 信任列表**：用户当日连续通过 N 次 AI 检测后加入信任列表，当日免检，降低 API 成本
- **每日重置**：信任仅当日有效，第二天归零重新积累
- **与黑白名单解耦**：AI 信任列表仅控制是否跳过 AI 检测，与项目黑名单（is_blocked）完全独立
- **fail-open 策略**：AI 不可用或超时时放行消息，不误杀
- **管理员命令**：`/trust` 加入 AI 信任列表，`/untrust` 移出

---

## 部署指南

### 方式一：Cloudflare Dashboard 关联仓库（推荐）

#### 前置准备

1. **创建 D1 数据库**
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
   - 进入 **存储和数据库 → D1 数据库**
   - 点击 **创建数据库**，命名为 `tg-bot-db`（或自定义名称）
   - **记录数据库 ID**（创建后在数据库详情页查看，格式如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）
   - **无需手动建表** - 代码会在首次请求时自动创建所有表结构

2. **Fork 本仓库** 到你的 GitHub/GitLab 账号

3. **修改 `wrangler.toml`**
   在 Fork 的仓库中编辑 `wrangler.toml` 文件：
   ```toml
   name = "tg-chat-bot-d1"
   main = "src/index.js"
   compatibility_date = "2024-01-01"

   # D1 数据库绑定
   [[d1_databases]]
   binding = "TG_BOT_DB"
   database_name = "tg-bot-db"
   database_id = "你的数据库ID"  # <-- 替换为步骤1中记录的数据库ID
   ```

#### 部署步骤

4. **登录 Cloudflare Dashboard**
   - 进入 **Workers & Pages**
   - 点击 **创建应用程序**
   - 选择 **关联 Git 仓库**

5. **连接仓库**
   - 选择你 Fork 的仓库
   - 配置部署分支（推荐 `main`）
   - 点击 **保存并部署**

6. **配置环境变量**
   在 Worker **设置 → 变量** 中添加以下变量：

   | 变量名称 | 示例值 | 说明 |
   |----------|--------|------|
   | `BOT_TOKEN` | `12345:AAH...` | Bot Token（从 @BotFather 获取）|
   | `ADMIN_IDS` | `123456,789012` | 管理员 ID（多人用英文逗号分隔，**无空格**）|
   | `ADMIN_GROUP_ID` | `-100123456789` | 开启话题的超级群组 ID |
   | `WORKER_URL` | `https://xxx.workers.dev` | Worker 完整访问链接（**不带末尾斜杠**）|
   | `TURNSTILE_SITE_KEY` | `0x4AAAA...` | Turnstile 站点密钥 |
   | `TURNSTILE_SECRET_KEY` | `0x4AAAA...` | Turnstile 密钥 |
   | `RECAPTCHA_SITE_KEY` | `6LAAAA...` | Google reCAPTCHA v2 站点密钥 |
   | `RECAPTCHA_SECRET_KEY` | `6LAAAA...` | Google reCAPTCHA v2 密钥 |
   | `TELEGRAM_WEBHOOK_SECRET` | `mRD0p7...` | 随机字符串（用于 Webhook 校验）|
   | `LLM_API` | `https://api.openai.com/v1` | LLM API Base URL（AI反骚扰可选）|
   | `LLM_MODEL` | `gpt-4o-mini` | LLM 模型名称（AI反骚扰可选）|
   | `LLM_KEY` | `sk-...` | LLM API Key（用 wrangler secret put 设置）|
   | `LLM_TIMEOUT_MS` | `5000` | LLM API 超时（毫秒，可选）|

7. **设置 Webhook**
   在浏览器地址栏输入：
   ```
   https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=<你的WORKER_URL>/&secret_token=<你的TELEGRAM_WEBHOOK_SECRET>
   ```
   
   成功响应：
   ```json
   {"ok":true,"result":true,"description":"Webhook was set"}
   ```

### 方式二：Wrangler CLI 部署

```bash
# 1. 克隆仓库
git clone https://github.com/your-repo/tg-chat-bot-d1.git
cd tg-chat-bot-d1

# 2. 创建 D1 数据库（记录返回的 database_id）
npx wrangler d1 create tg-bot-db

# 3. 编辑 wrangler.toml，填入 database_id
# [[d1_databases]]
# binding = "TG_BOT_DB"
# database_name = "tg-bot-db"
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# 4. 配置环境变量
npx wrangler secret put BOT_TOKEN
npx wrangler secret put ADMIN_IDS
npx wrangler secret put ADMIN_GROUP_ID
npx wrangler secret put WORKER_URL
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put LLM_KEY
# ... 其他变量

# 5. 本地开发
npm run dev

# 6. 部署
npm run deploy
```

---

## 准备工作

1. [Cloudflare 账号](https://dash.cloudflare.com/)
2. Telegram Bot Token（通过 [@BotFather](https://t.me/BotFather) 获取）
3. Telegram 管理员群组 ID（必须是**开启话题功能的超级群组**，ID 以 `-100` 开头，通过 [@raw_data_bot](https://t.me/raw_data_bot) 获取）
4. 管理员 ID（你自己的 TG ID，通过 [@raw_data_bot](https://t.me/raw_data_bot) 获取）

> **升级超级群组技巧**：
> 1. 将群组的 **新成员是否可见消息记录** 设置为 **可见**
> 2. 在 **管理员权限** 中细分权限，关闭 bot 用不上的权限

---

## 配置 Turnstile 验证

1. 在 Cloudflare 侧边栏选择 **Turnstile → 添加站点**
2. 填写配置：
   - **站点名称**：任意（如 `tg-bot-verification`）
   - **域**：填写 Worker 域名（例如 `your-worker.your-subdomain.workers.dev` 或 `workers.dev`）
   - **模式**：选择 **托管 (Managed)**
3. 创建后复制 **站点密钥 (Site Key)** 和 **密钥 (Secret Key)**

> Google reCAPTCHA 需自行在 [Google reCAPTCHA Admin Console](https://www.google.com/recaptcha/admin) 创建（选择 **v2 Checkbox** 类型）

---

## 常见问题

| 问题现象 | 可能原因 | 解决方案 |
|----------|----------|----------|
| `系统忙，请稍后再试` | 1. 机器人未获得足够权限<br>2. 群组 ID 错误<br>3. 群组未升级为超级群组<br>4. 未开启话题功能 | 1. 检查群组是否为超级群组<br>2. 确认群组设置中 **开启话题**<br>3. 通过 [@raw_data_bot](https://t.me/raw_data_bot) 检查群组状态 |
| `私聊 BOT /start 无反应` | `BOT_TOKEN` 配置错误 | 1. 重新从 @BotFather 获取 Token<br>2. 检查环境变量是否有拼写错误<br>3. 重新设置 webhook |
| `回复消息无反应` | `ADMIN_IDS` 配置错误 | 1. 通过 [@raw_data_bot](https://t.me/raw_data_bot) 确认你的 TG ID<br>2. 检查环境变量中 ID 是否正确且无空格 |
| `点击配置菜单出现 ERROR` | D1 数据库未绑定或变量名错误 | 1. 检查绑定变量名是否为 `TG_BOT_DB`（大小写敏感）<br>2. 确认数据库已正确创建<br>3. 首次访问会自动建表，无需手动执行 SQL |
| `点击配置菜单无反应` | D1 数据库配置错误 | 1. 重新绑定数据库<br>2. 检查 Worker 代码是否包含最新 D1 初始化逻辑 |
| `AI 检测不工作` | LLM 环境变量未配置 | 1. 检查 `LLM_API`/`LLM_MODEL`/`LLM_KEY` 是否配置<br>2. 确认管理面板中 AI 反骚扰总开关已开启<br>3. 检查 `LLM_KEY` 是否有效（用 curl 测试）|

---

## 工作流文档

详细的项目工作流程文档，包含架构图、消息流转图、时序图等，请查看 [WORKFLOW.md](WORKFLOW.md)

---

## 开发指南

### 项目结构说明

- **handlers/**：处理 Telegram 消息和回调的业务逻辑
- **services/**：核心功能服务（转发、通知、验证等）
- **security/**：安全防护（限流、幂等、验签等）
- **database/**：D1 数据库操作封装
- **api/**：Telegram Bot API 调用封装
- **utils/**：工具函数和常量定义

### 添加新功能

1. 在 `services/` 创建新服务模块
2. 在 `handlers/` 创建对应处理器（如需要）
3. 在 `router/index.js` 注册新路由（如需要）
4. 更新 `README.md` 文档

### 本地测试

```bash
# 安装 Wrangler CLI
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 本地开发服务器
npm run dev

# 查看日志
npm run tail
```

---

## 技术栈

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Language**: JavaScript (ES Modules)
- **API**: Telegram Bot API
- **Security**: Cloudflare Turnstile / Google reCAPTCHA

---

## 许可证

本项目采用 [MIT 许可证](LICENSE)

---

> **提示**：部署完成后，向机器人发送 `/start` 即可体验完整功能！
> 
> 遇到问题？请在 [Issues](https://github.com/huliyoudiangou/TG_Chat_Bot-D1/issues) 提交详细日志

**给项目一个 Star 吧！您的支持是我们持续更新的动力！**
