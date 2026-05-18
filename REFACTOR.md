# TG_Chat_Bot-D1 v4.0 重构说明

## 项目结构

本项目已从单体文件重构为模块化架构，支持通过 Cloudflare Workers 后台关联仓库部署。

```
tg-chat-bot-d1/
├── src/
│   ├── index.js                 # Worker 入口
│   ├── router/
│   │   └── index.js             # 路由分发器
│   ├── handlers/                # 业务处理器
│   │   ├── update.js            # Update 主分发器
│   │   ├── private.js           # 私聊处理
│   │   ├── adminReply.js        # 管理员回复
│   │   ├── callback.js          # 回调处理
│   │   ├── edit.js              # 编辑消息
│   │   ├── verifyPage.js        # 验证页面
│   │   ├── tokenSubmit.js       # Token 提交
│   │   └── adminConfig.js       # 管理面板
│   ├── services/                # 核心服务
│   │   ├── relay.js             # 消息转发
│   │   ├── topic.js             # 话题管理
│   │   ├── inbox.js             # 未读通知
│   │   ├── blacklist.js         # 黑名单
│   │   ├── backup.js            # 备份
│   │   ├── infoCard.js          # 资料卡
│   │   └── verification.js      # 验证服务
│   ├── security/                # 安全层
│   │   ├── webhook.js           # Webhook 校验
│   │   ├── rateLimit.js         # 限流
│   │   ├── idempotency.js       # 幂等去重
│   │   ├── initData.js          # initData 验签
│   │   ├── regexGuard.js        # ReDoS 防护
│   │   ├── cleanup.js           # 清理调度
│   │   ├── connectivityCheck.js # AI/Green 连通性检测
│   │   ├── antiHarassment.js    # 本地反骚扰检测
│   │   ├── aiAntiHarassment.js  # AI 反骚扰检测
│   │   ├── aiSpamPrompt.js      # LLM 提示词模板
│   │   ├── greenAntiHarassment.js # Green 反骚扰检测
│   │   └── aliyunGreen.js       # Green API 签名+调用
│   ├── database/                # 数据层
│   │   ├── index.js             # DB 初始化
│   │   ├── config.js            # 配置操作
│   │   ├── users.js             # 用户操作
│   │   ├── messages.js          # 消息操作
│   │   ├── updates.js           # Update 记录
│   │   └── rateLimits.js        # 限流记录
│   ├── api/                     # API 层
│   │   ├── telegram.js          # TG API 封装
│   │   └── commands.js          # 命令管理
│   └── utils/                   # 工具层
│       ├── constants.js         # 常量定义
│       ├── helpers.js           # 辅助函数
│       ├── cache.js             # 缓存管理
│       └── templates.js         # HTML 模板
├── wrangler.toml                # Cloudflare Workers 配置
├── package.json                 # 项目配置
└── README.md                    # 项目文档
```

## 部署方式

### 方式一：Cloudflare Dashboard 关联仓库

1. 将代码推送到 GitHub/GitLab 仓库
2. 登录 Cloudflare Dashboard
3. 进入 **Workers & Pages**
4. 选择 **创建 Worker** → **关联 Git 仓库**
5. 选择你的仓库并配置部署分支
6. 在 **设置 → 变量** 中配置环境变量
7. 在 **设置 → 绑定** 中绑定 D1 数据库（变量名：`TG_BOT_DB`）

### 方式二：Wrangler CLI

```bash
# 安装依赖
npm install

# 本地开发
npm run dev

# 部署
npm run deploy
```

## 环境变量

| 变量名称 | 说明 |
|----------|------|
| `BOT_TOKEN` | Telegram Bot Token |
| `ADMIN_IDS` | 管理员 ID（逗号分隔） |
| `ADMIN_GROUP_ID` | 管理员群组 ID |
| `WORKER_URL` | Worker 访问地址 |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile 站点密钥 |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile 密钥 |
| `RECAPTCHA_SITE_KEY` | Google reCAPTCHA 站点密钥 |
| `RECAPTCHA_SECRET_KEY` | Google reCAPTCHA 密钥 |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook 密钥 |
| `LLM_API` | LLM API Base URL（AI反骚扰可选）|
| `LLM_MODEL` | LLM 模型名称（AI反骚扰可选）|
| `LLM_KEY` | LLM API Key（AI反骚扰）|
| `LLM_TIMEOUT_MS` | LLM API 超时毫秒数（可选）|
| `ALIYUN_ACCESS_KEY_ID` | 阿里云 AccessKey ID（Green反骚扰）|
| `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 AccessKey Secret（Green反骚扰）|
| `ALIYUN_GREEN_REGION` | Green API 地域（可选，默认新加坡）|
| `ALIYUN_GREEN_SERVICE` | 检测服务类型（可选，默认出海版）|
| `ALIYUN_GREEN_TIMEOUT_MS` | Green API 超时毫秒数（可选）|

## 功能清单

- [x] Webhook secret_token 校验
- [x] Update 幂等去重
- [x] 全局/单用户限流
- [x] TG API 重试与退避
- [x] 话题创建分布式幂等
- [x] 三模态验证（Turnstile/reCAPTCHA/QA）
- [x] 私聊消息转发到话题
- [x] 管理员回复转发给用户
- [x] 用户资料卡与置顶
- [x] 聚合收件箱（未读通知）
- [x] 黑名单管理
- [x] 消息备份
- [x] 屏蔽词检测
- [x] 自动回复
- [x] 忙碌模式
- [x] 管理面板
- [x] 协管权限系统
- [x] ReDoS 防护
- [x] TTL 清理
- [x] AI 反骚扰检测（LLM 语义检测）
- [x] Green 反骚扰检测（阿里云内容安全出海版）
- [x] AI 与 Green 互斥切换
- [x] 信任列表系统（共享 AI/Green）
- [x] 连通性检测（开启前验证 API 可达）

## 架构特点

1. **模块化**：40+ 个模块，职责单一
2. **可测试**：模块间解耦，支持独立测试
3. **可扩展**：新增功能无需修改现有代码
4. **安全**：多层安全防护（Webhook、限流、幂等、ReDoS）
5. **性能**：内存缓存 + D1 数据库，支持高并发
