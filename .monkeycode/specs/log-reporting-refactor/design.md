# 对日志上报优化 - 技术设计文档

## 1. 概述

### 1.1 背景

当前项目日志/错误上报存在以下核心问题：

- **格式不统一**：39 处 console 调用（5 log / 16 error / 2 warn）缺乏统一规范，有的用 `[Tag]` 前缀，有的用裸字符串
- **静默吞错**：~32 处 `.catch(() => {})` 和空 `catch {}`，关键错误完全丢失（如 tokenSubmit 外层 catch 无日志）
- **缺乏上下文**：多数日志无 userId/requestId，无法串联请求链路
- **级别混用**：console.error 输出 debug 信息（adminConfig 连通性检测），console.log 输出业务事件（反骚扰拦截）
- **安全风险**：`SQL Fail [${query}]` 日志包含完整 SQL 语句，可能泄露用户数据
- **无持久化**：仅输出到 Cloudflare Worker stdout/stderr，执行完毕即丢失

### 1.2 目标

1. 建立统一日志模块，规范格式、级别和上下文
2. 消除所有静默吞错，关键路径至少 WARN 级别输出
3. 为每个请求生成唯一 ID，串联完整调用链路
4. 支持结构化日志输出，为 Cloudflare Logpush / wrangler tail / Sentry 等外部收集预留接口
5. SQL 日志脱敏，消除安全风险

---

## 2. 统一日志模块设计

### 2.1 模块位置与接口

**文件**：`src/utils/logger.js`

```javascript
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SILENT: 4 };
const CURRENT_LEVEL = LOG_LEVELS[LOG_LEVELS.INFO];

export function setLogLevel(level) {
  CURRENT_LEVEL = LOG_LEVELS[level] ?? LOG_LEVELS.INFO;
}

export const log = {
  debug(tag, msg, ctx = {}) {
    if (CURRENT_LEVEL > LOG_LEVELS.DEBUG) return;
    _out('debug', tag, msg, ctx);
  },
  info(tag, msg, ctx = {}) {
    if (CURRENT_LEVEL > LOG_LEVELS.INFO) return;
    _out('info', tag, msg, ctx);
  },
  warn(tag, msg, ctx = {}) {
    if (CURRENT_LEVEL > LOG_LEVELS.WARN) return;
    _out('warn', tag, msg, ctx);
  },
  error(tag, msg, ctx = {}) {
    _out('error', tag, msg, ctx);
  },
};

function _out(level, tag, msg, ctx) {
  const ts = new Date().toISOString();
  const ctxStr = Object.keys(ctx).length ? JSON.stringify(ctx) : '';
  const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}${ctxStr ? ' ' + ctxStr : ''}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line);
}
```

### 2.2 设计要点

| 要点 | 说明 |
|------|------|
| **统一前缀格式** | `[timestamp] [LEVEL] [TAG] message {ctx}` |
| **TAG 来源映射** | 每个模块固定 TAG：`DB` / `TG` / `Relay` / `AntiHarass` / `AiAntiHarass` / `TmsAntiHarass` / `TMS` / `Config` / `TokenSubmit` / `Inbox` / `Blacklist` / `Backup` / `InfoCard` / `Permission` / `Worker` |
| **ctx 结构化上下文** | 必须字段：`userId`(如有)、`requestId`(如有)；可选字段：`topicId`、`chatId`、`method` 等 |
| **ERROR 永不跳过** | 无论 LOG_LEVEL 设置，ERROR 级别始终输出 |
| **动态 LOG_LEVEL** | 通过 `LOG_LEVEL` 环境变量控制，默认 INFO |

### 2.3 Request ID 生成与传递

**文件**：`src/router/index.js`（入口）

```javascript
import { genRequestId } from '../utils/logger.js';

export async function route(req, env, ctx) {
  const requestId = genRequestId();
  ctx.requestId = requestId;  // 注入到 Worker ctx
  // ... 后续所有模块通过 ctx.requestId 获取
}
```

**文件**：`src/utils/logger.js`

```javascript
export function genRequestId() {
  return crypto.randomUUID().replace('-', '').substring(0, 16);
}
```

传递方式：`ctx.requestId` 作为 Worker 上下文属性注入，所有模块通过 `ctx.requestId` 获取。不通过函数参数传递（避免改动所有函数签名），仅在需要日志的模块从 ctx 取。

---

## 3. 各模块改造细则

### 3.1 入口层 (src/index.js + src/router/index.js)

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.error("DB Init Failed:", e)` | `log.error('Worker', 'DB init failed', { error: e.message })` | 结构化 + 不直接输出 error 对象 |
| `console.error("Critical Worker Error:", e)` | `log.error('Worker', 'Critical error', { requestId: ctx.requestId, error: e.message, stack: e.stack })` | 附 requestId + stack |
| 内层 `catch {}` (JSON 解析) | `log.warn('Worker', 'Invalid request body', { requestId: ctx.requestId })` | 补充 WARN |
| 新增 | `const requestId = genRequestId(); ctx.requestId = requestId;` | 为每个请求生成唯一 ID |

### 3.2 数据层 (src/database/)

#### database/index.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.error("SQL Fail [${query}]:", e)` | `log.error('DB', 'SQL failed', { op: _sqlOp(query), table: _sqlTable(query), error: e.message })` | SQL 脱敏：只输出操作类型+表名 |
| `tryRun()` catch 返回 null | `log.warn('DB', 'SQL tryRun failed', { op, table, error: e.message })` | 补充 WARN 日志 |
| `ensureUserColumns` catch {} | `log.info('DB', 'Column migration skipped', { column })` | 降级为 INFO |

新增辅助函数 `_sqlOp(query)` 和 `_sqlTable(query)`：

```javascript
function _sqlOp(q) {
  const m = q.match(/^(INSERT|UPDATE|DELETE|SELECT|REPLACE|ALTER|CREATE)/i);
  return m ? m[1].toUpperCase() : 'UNKNOWN';
}
function _sqlTable(q) {
  const m = q.match(/(?:INTO|FROM|UPDATE|TABLE)\s+(\w+)/i);
  return m ? m[1] : 'unknown';
}
```

#### database/trust.js（当前零错误处理）

为所有 6 个 D1 操作添加 try/catch + log.error：

```javascript
export async function trustUser(db, userId) {
  try {
    await db.prepare('INSERT OR REPLACE INTO ai_trust ...').bind(userId).run();
  } catch (e) {
    log.error('DB', 'Trust insert failed', { userId, error: e.message });
  }
}
```

#### database/users.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| INSERT catch {} | `log.warn('DB', 'User insert skipped', { userId, error: e.message })` | 补充 WARN |
| UPDATE catch console.error | `log.error('DB', 'User update failed', { userId, error: e.message })` | 结构化 |

#### database/messages.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.error("Save Message Failed:", e)` | `log.error('DB', 'Save message failed', { userId, error: e.message })` | 结构化 |
| `console.error("Cleanup Messages Failed:", e)` | `log.error('DB', 'Cleanup messages failed', { error: e.message })` | 结构化 |

#### database/updates.js

| `console.error("Cleanup Updates Failed:", e)` | `log.error('DB', 'Cleanup updates failed', { error: e.message })` | 结构化 |
| `markUpdateProcessed` catch 返回 true | `log.warn('DB', 'Mark update failed', { updateId, error: e.message })` | 补充 WARN |

#### database/rateLimits.js

| `console.error("Cleanup RateLimits Failed:", e)` | `log.error('DB', 'Cleanup rateLimits failed', { error: e.message })` | 结构化 |

### 3.3 API 层 (src/api/)

#### api/telegram.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.warn("TG API Error [method]:", desc)` | `log.warn('TG', 'API error', { method, desc, requestId })` | 结构化 |
| `console.warn("TG API Fail [method]:", e?.message)` | `log.error('TG', 'API call failed', { method, error: e.message, requestId })` | 升级为 ERROR |
| `r.json().catch(() => null)` | `log.debug('TG', 'JSON parse failed', { method, requestId })` + return null | 补充 DEBUG |

### 3.4 处理器层 (src/handlers/)

#### handlers/tokenSubmit.js（重点改造）

**当前问题**：外层 catch 完全静默，所有 throw Error 同质化处理。

**改造方案**：

```javascript
import { log } from '../utils/logger.js';
import { BusinessError } from '../utils/logger.js';

// 外层 catch 改造
} catch (e) {
  if (e instanceof BusinessError) {
    log.warn('TokenSubmit', e.message, { userId, code: e.code, requestId: ctx.requestId });
  } else {
    log.error('TokenSubmit', 'Unexpected error', { error: e.message, stack: e.stack, requestId: ctx.requestId });
  }
  return { success: false, error: e.code ?? 'server_error' };
}
```

新增 `BusinessError` 类：

```javascript
export class BusinessError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
```

替换所有 `throw new Error(...)` 为 `throw new BusinessError(...)`：

| 当前 throw | 改造后 |
|------------|--------|
| `throw new Error("Rate limited")` | `throw new BusinessError("Rate limited", "rate_limited")` |
| `throw new Error("Missing initData")` | `throw new BusinessError("Missing initData", "missing_init_data")` |
| `throw new Error("Missing uid")` | `throw new BusinessError("Missing uid", "missing_uid")` |
| `throw new Error("uid mismatch")` | `throw new BusinessError("uid mismatch", "uid_mismatch")` |
| `throw new Error("blocked")` | `throw new BusinessError("blocked", "blocked")` |
| `throw new Error("nonce invalid")` | `throw new BusinessError("nonce invalid", "nonce_invalid")` |
| `throw new Error("Token Invalid")` | `throw new BusinessError("Token Invalid", "token_invalid")` |

内层 catch（用户信息更新）改造：

```javascript
} catch (e) {
  log.warn('TokenSubmit', 'User info update skipped', { uid, error: e.message });
}
```

#### handlers/private.js

消除 7 处 `.catch(() => {})`，改为 `.catch(e => log.warn('Private', 'TG notification failed', { userId, method, error: e.message }))`。

补充 3 处 try/catch 日志：
- 114 行 catch：`log.error('Private', 'Handle message failed', { userId, error: e.message, requestId })`
- 221 行 catch {}：`log.warn('Private', 'Welcome data parse failed', { userId })`
- 230 行 catch {}：`log.info('Private', 'Media send fallback to text', { userId })`

#### handlers/callback.js

消除 8 处 `.catch(() => {})`，统一改为：

```javascript
.catch(e => log.debug('Callback', 'TG API call skipped', { method, chatId, error: e.message }))
```

`answerCallbackQuery` 等高频非关键调用用 DEBUG 级别（生产环境默认 INFO 不输出，通过 LOG_LEVEL=DEBUG 开启）。

#### handlers/adminConfig.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.error("[CHECK_AI] Starting...")` | `log.debug('Config', 'AI connectivity check starting')` | debug 信息降级 |
| `console.error("[CHECK_AI] Result:", ...)` | `log.info('Config', 'AI connectivity check result', { result })` | 结构化 |
| `console.error("[CHECK_PERMS] Error:", e)` | `log.error('Config', 'Permission check failed', { error: e.message, requestId })` | 结构化 |
| `console.error("handleAdminConfig error:", e)` | `log.error('Config', 'Admin config handler failed', { requestId, error: e.message, stack: e.stack })` | 附 stack |
| `.catch(() => {})` (2处) | `.catch(e => log.debug('Config', 'TG notification skipped', { error: e.message }))` | 补充 DEBUG |

#### handlers/adminReply.js

| `.catch(() => {})` (2处) | `.catch(e => log.warn('AdminReply', 'TG API call failed', { chatId, method, error: e.message }))` | 补充 WARN |
| try/catch (行80) | `log.error('AdminReply', 'Reply handler failed', { adminId, error: e.message })` | 补充 ERROR |

#### handlers/edit.js

| `.catch(() => {})` | `.catch(e => log.debug('Edit', 'Edit notification skipped', { error: e.message }))` | 补充 DEBUG |

### 3.5 服务层 (src/services/)

#### services/relay.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.error("Copy Failed:", cpErr)` | `log.error('Relay', 'Copy message failed', { userId, error: cpErr.message })` | 结构化 |
| `console.error("Topic Create Error:", e)` | `log.error('Relay', 'Topic create failed', { userId, error: e.message, requestId })` | 结构化 |
| `saveMessage catch {}` | `log.warn('Relay', 'Save message skipped', { userId, error: e.message })` | 补充 WARN |
| `.catch(() => {})` (系统繁忙通知) | `.catch(e => log.debug('Relay', 'Busy notification skipped', { userId, error: e.message }))` | 补充 DEBUG |
| `markDelivered catch {}` | `log.warn('Relay', 'Mark delivered skipped', { messageId })` | 补充 WARN |

#### services/inbox.js

| try/catch (createForumTopic catch 直接 return) | `log.error('Inbox', 'Inbox topic create failed', { userId, error: e.message })` | 补充 ERROR |
| 内层 `catch {}` (editMessageText) | `log.warn('Inbox', 'Inbox card edit failed', { userId, error: e.message })` | 补充 WARN |

#### services/blacklist.js

| try/catch (createForumTopic 直接 return) | `log.error('Blacklist', 'Blacklist topic create failed', { userId, error: e.message })` | 补充 ERROR |
| `.catch(() => {})` (2处) | `.catch(e => log.warn('Blacklist', 'TG API call failed', { method, error: e.message }))` | 补充 WARN |

#### services/backup.js

| try/catch (copyMessage 降级) | `log.info('Backup', 'Backup fallback to text', { userId })` | 降级为 INFO（是正常降级路径） |
| `.catch(() => {})` | `.catch(e => log.warn('Backup', 'Backup notification skipped', { error: e.message }))` | 补充 WARN |

#### services/infoCard.js

| try/catch (返回 null) | `log.error('InfoCard', 'Info card generate failed', { userId, error: e.message })` | 补充 ERROR |
| `.catch(() => {})` | `.catch(e => log.debug('InfoCard', 'Pin card skipped', { error: e.message }))` | 补充 DEBUG |

#### services/permissionCheck.js

| 所有 try/catch | 在 catch 中补充 `log.warn('Permission', 'Check item failed', { item, error: e.message })` | 补充 WARN |
| `.catch(() => {})` (deleteMessage) | `.catch(e => log.debug('Permission', 'Cleanup message skipped', { error: e.message }))` | 补充 DEBUG |

### 3.6 安全层 (src/security/)

#### security/antiHarassment.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.log('[AntiHarassment] User triggered rule...')` (4处) | `log.info('AntiHarass', 'Rule triggered', { userId, rule, reason })` | 结构化 INFO |
| `console.error('[AntiHarassment] User intercept failed...')` (2处) | `log.error('AntiHarass', 'Intercept failed', { userId, error: e.message })` | 结构化 ERROR |
| `.catch(() => {})` (sendMessage) | `.catch(e => log.debug('AntiHarass', 'Intercept notification skipped', { userId, error: e.message }))` | 补充 DEBUG |

#### security/aiAntiHarassment.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.error('[AiAntiHarassment] LLM API call failed:', error)` | `log.error('AiAntiHarass', 'LLM API call failed', { error: error.message })` | 结构化 |
| `console.log('[AiAntiHarassment] User promoted to trust')` | `log.info('AiAntiHarass', 'User promoted to trust', { userId })` | 结构化 INFO |
| `console.error('[AiAntiHarassment] AI spam intercept failed')` | `log.error('AiAntiHarass', 'Intercept failed', { userId, error: e.message })` | 结构化 |
| `console.error('[AiAntiHarassment] Clean pass processing failed')` | `log.error('AiAntiHarass', 'Clean pass failed', { userId, error: e.message })` | 结构化 |
| `.catch(() => {})` | `.catch(e => log.debug('AiAntiHarass', 'Intercept notification skipped', { userId, error: e.message }))` | 补充 DEBUG |

#### security/tmsAntiHarassment.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.error('[TmsAntiHarassment] TMS API call failed:')` | `log.error('TmsAntiHarass', 'TMS API call failed', { error: error.message })` | 结构化 |
| `console.log('[TmsAntiHarassment] User promoted')` | `log.info('TmsAntiHarass', 'User promoted to trust', { userId })` | 结构化 INFO |
| `console.error('[TmsAntiHarassment] ... intercept failed')` | `log.error('TmsAntiHarass', 'Intercept failed', { userId, error: e.message })` | 结构化 |
| `console.error('[TmsAntiHarassment] Clean pass failed')` | `log.error('TmsAntiHarass', 'Clean pass failed', { userId, error: e.message })` | 结构化 |
| `.catch(() => {})` (2处) | `.catch(e => log.debug('TmsAntiHarass', 'Notification skipped', { userId, error: e.message }))` | 补充 DEBUG |

#### security/tencentTms.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `console.error("[TMS] Calling API, region:... text: content.substring(0,50)")` | `log.debug('TMS', 'API call starting', { region })` | **脱敏：移除用户消息内容** |
| `console.error("[TMS] Response status:... data: JSON.stringify(data).substring(0,200)")` | `log.debug('TMS', 'API response received', { status: response.status })` | **脱敏：移除响应内容** |
| throw Error (3处) | 保持 throw，上层已改造为日志输出 | throw 不改 |

#### security/initData.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| throw Error (4处) | 改为 `throw new BusinessError(msg, code)` | 统一业务异常 |
| JSON.parse catch {} | `log.warn('InitData', 'User JSON parse failed', { userId })` | 补充 WARN |

#### security/regexGuard.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| catch 返回 false | `log.warn('RegexGuard', 'Regex test failed, allowing', { pattern, error: e.message })` | 补充 WARN（安全降级需记录） |

#### security/webhook.js / rateLimit.js / idempotency.js / cleanup.js

这些模块是纯函数或调度模块，无需改造。

### 3.7 工具层 (src/utils/)

#### utils/helpers.js

| 当前代码 | 改造后 | 说明 |
|----------|--------|------|
| `safeParse catch` 返回 fb | 保持不变（是工具函数的预期降级路径） | 无需日志 |
| `safeWaitUntil .catch(() => {})` (2处) | `.catch(e => log.debug('Helpers', 'WaitUntil promise rejected', { error: e.message }))` | 补充 DEBUG |

---

## 4. 全模块 TAG 映射表

| 模块路径 | TAG | 说明 |
|----------|-----|------|
| src/index.js | Worker | 入口 |
| src/router/index.js | Worker | 路由 |
| src/handlers/update.js | Update | 分发 |
| src/handlers/private.js | Private | 私聊 |
| src/handlers/adminReply.js | AdminReply | 管理员回复 |
| src/handlers/callback.js | Callback | 回调 |
| src/handlers/edit.js | Edit | 编辑 |
| src/handlers/verifyPage.js | Verify | 验证页 |
| src/handlers/tokenSubmit.js | TokenSubmit | Token 提交 |
| src/handlers/adminConfig.js | Config | 配置面板 |
| src/services/relay.js | Relay | 转发 |
| src/services/topic.js | Topic | 话题 |
| src/services/inbox.js | Inbox | 收件箱 |
| src/services/blacklist.js | Blacklist | 黑名单 |
| src/services/backup.js | Backup | 备份 |
| src/services/infoCard.js | InfoCard | 资料卡 |
| src/services/verification.js | Verify | 验证服务 |
| src/services/permissionCheck.js | Permission | 权限检查 |
| src/database/index.js | DB | 数据库 |
| src/database/config.js | DB | 配置 |
| src/database/users.js | DB | 用户 |
| src/database/messages.js | DB | 消息 |
| src/database/updates.js | DB | Update 记录 |
| src/database/rateLimits.js | DB | 限流 |
| src/database/trust.js | DB | 信任 |
| src/api/telegram.js | TG | Telegram API |
| src/api/commands.js | Commands | 命令 |
| src/security/webhook.js | Webhook | Webhook |
| src/security/rateLimit.js | RateLimit | 限流 |
| src/security/idempotency.js | Idempotency | 幂等 |
| src/security/initData.js | InitData | initData |
| src/security/regexGuard.js | RegexGuard | ReDoS |
| src/security/cleanup.js | Cleanup | 清理 |
| src/security/antiHarassment.js | AntiHarass | 反骚扰 |
| src/security/aiAntiHarassment.js | AiAntiHarass | AI 反骚扰 |
| src/security/tmsAntiHarassment.js | TmsAntiHarass | TMS 反骚扰 |
| src/security/tencentTms.js | TMS | 腾讯 TMS |
| src/utils/logger.js | Logger | 日志自身 |
| src/utils/helpers.js | Helpers | 辅助 |
| src/utils/constants.js | Constants | 常量 |
| src/utils/cache.js | Cache | 缓存 |
| src/utils/templates.js | Templates | 模板 |

---

## 5. 日志级别使用规范

| 级别 | 适用场景 | 示例 |
|------|----------|------|
| **DEBUG** | 开发调试信息、高频非关键 TG API 通知跳过 | `[DEBUG] [Callback] TG API call skipped` |
| **INFO** | 业务状态变更、正常流程节点、降级路径 | `[INFO] [AntiHarass] Rule triggered` / `[INFO] [Backup] Fallback to text` |
| **WARN** | 非致命异常、预期内的失败、静默吞错升级 | `[WARN] [DB] User insert skipped` / `[WARN] [Private] Welcome data parse failed` |
| **ERROR** | 系统异常、关键操作失败、需立即关注 | `[ERROR] [Relay] Topic create failed` / `[ERROR] [Worker] Critical error` |

### 级别决策树

```
错误是否影响核心功能？
  是 → ERROR（如：转发失败、DB 写入失败、Worker 崩溃）
  否 → 是否是预期降级路径？
    是 → INFO（如：备份降级为文本、regexGuard 降级为放行）
    否 → 是否需要开发时关注？
      是 → WARN（如：DB INSERT 跳过、TG API 非关键失败）
      否 → DEBUG（如：answerCallbackQuery 跳过、waitUntil promise rejected）
```

---

## 6. 与 Cloudflare Workers 的适配

### 6.1 wrangler tail 对接

当前 `wrangler tail` 命令可实时查看 Worker 日志。统一格式后：

```bash
wrangler tail --format json
```

输出每条日志为 JSON 行，可直接用于日志分析工具。

### 6.2 Cloudflare Logpush 预留

日志格式 `[timestamp] [LEVEL] [TAG] message {ctx_json}` 可被 Logpush 妥善解析：
- timestamp 字段满足时间排序
- LEVEL 字段满足过滤
- TAG 字段满足模块过滤
- ctx_json 满足结构化查询

### 6.3 LOG_LEVEL 环境变量

通过 Cloudflare Worker 环境变量 `LOG_LEVEL` 控制输出：

```toml
# wrangler.toml
[vars]
LOG_LEVEL = "INFO"   # 生产环境
# LOG_LEVEL = "DEBUG" # 调试时
```

### 6.4 Sentry 等外部 APM 预留

`log.error()` 输出的结构化 JSON 可直接转换为 Sentry event：
- `tag` → Sentry tag
- `ctx` → Sentry extra context
- `requestId` → Sentry trace_id

未来只需在 `_out()` 函数中增加 Sentry 上报逻辑即可，无需改造各模块。

---

## 7. 改造优先级与分期计划

### Phase 1：核心基础设施（优先级：最高）

| 任务 | 涉及文件 | 预估改动 |
|------|----------|----------|
| 新建 `src/utils/logger.js` | 新文件 | ~50 行 |
| 新增 `BusinessError` 类 | logger.js | ~10 行 |
| Router 注入 requestId | router/index.js | 2 行 |
| index.js 入口日志改造 | index.js | 1 行 |

### Phase 2：关键路径消除静默吞错（优先级：高）

| 任务 | 涉及文件 | 预估改动 |
|------|----------|----------|
| tokenSubmit 全面改造 | handlers/tokenSubmit.js | ~20 行 |
| database/trust.js 添加 try/catch | database/trust.js | ~30 行 |
| database/index.js SQL 脱敏 | database/index.js | ~15 行 |
| database/users/messages/updates/rateLimits | 4 文件 | ~15 行 |

### Phase 3：消除 .catch(() => {})（优先级：中）

| 任务 | 涉及文件 | 预估改动 |
|------|----------|----------|
| handlers/private.js (7处) | private.js | ~14 行 |
| handlers/callback.js (8处) | callback.js | ~16 行 |
| handlers/adminConfig.js (2处) | adminConfig.js | ~4 行 |
| handlers/adminReply.js (2处) | adminReply.js | ~4 行 |
| handlers/edit.js (1处) | edit.js | ~2 行 |
| services/relay.js (3处) | relay.js | ~6 行 |
| services/inbox.js (1处) | inbox.js | ~2 行 |
| services/blacklist.js (2处) | blacklist.js | ~4 行 |
| services/backup.js (1处) | backup.js | ~2 行 |
| services/infoCard.js (1处) | infoCard.js | ~2 行 |
| services/permissionCheck.js (1处) | permissionCheck.js | ~2 行 |
| security 层 (5处) | 3 文件 | ~10 行 |
| utils/helpers.js (2处) | helpers.js | ~4 行 |

### Phase 4：现有 console 调用统一替换（优先级：中）

| 任务 | 涉及文件 | 预估改动 |
|------|----------|----------|
| security 层 console.log/error | antiHarassment/aiAntiHarassment/tmsAntiHarassment/tencentTms | ~20 行 |
| adminConfig console.error | adminConfig.js | ~15 行 |
| telegram.js console.warn | telegram.js | ~4 行 |
| relay.js console.error | relay.js | ~4 行 |

### Phase 5：验证与收尾

| 任务 | 说明 |
|------|------|
| 全量替换验证 | grep 确认无遗漏的 console.log/error/warn |
| grep 确认无遗漏的 .catch(() => {}) | 确认全部改造 |
| wrangler dev 本地测试 | 验证日志格式和级别输出 |
| wrangler tail --format json 测试 | 验证 JSON 输出解析 |

---

## 8. 改造前后对比

### 8.1 日志输出对比

**改造前**：
```
DB Init Failed: TypeError: ...
SQL Fail [INSERT INTO users (id, name, ...) VALUES (?, ?, ...)]: ...
Copy Failed: TypeError: ...
[AntiHarassment] User 12345 triggered rule: is_bot (Bot account)
```

**改造后**：
```
[2026-05-16T08:30:00.000Z] [ERROR] [Worker] DB init failed {"error":"TypeError: ..."}
[2026-05-16T08:30:01.000Z] [ERROR] [DB] SQL failed {"op":"INSERT","table":"users","error":"..."}
[2026-05-16T08:30:02.000Z] [ERROR] [Relay] Copy message failed {"userId":"12345","error":"TypeError: ..."}
[2026-05-16T08:30:03.000Z] [INFO] [AntiHarass] Rule triggered {"userId":"12345","rule":"is_bot","reason":"Bot account"}
```

### 8.2 问题定位对比

**改造前**：用户反馈"验证失败"，查看日志无任何记录。

**改造后**：
```
[2026-05-16T08:30:05.000Z] [WARN] [TokenSubmit] Missing initData {"code":"missing_init_data","userId":"12345","requestId":"a1b2c3d4"}
```

通过 requestId 可串联同一请求在所有模块的日志，快速定位问题链路。

---

## 9. 风险与注意事项

| 风险 | 缓解措施 |
|------|----------|
| Worker 代码体积增加（logger.js + BusinessError） | 新增约 60 行，远低于单个模块体量，影响极小 |
| 日志量增加可能影响 Cloudflare 计费 | 1) ERROR 永不跳过，量不增；2) DEBUG 生产默认关闭；3) WARN/INFO 仅补充原有静默处 |
| 改造范围广（32+ 文件） | 分 5 个 Phase 执行，Phase 1-2 可独立上线 |
| LOG_LEVEL 环境变量需配置 | 默认 INFO，无需额外配置；需要 DEBUG 时通过 wrangler.toml vars 设置 |
| SQL 脱敏可能影响排障 | 保留 op+table 足够定位问题，必要时临时开启 DEBUG 输出完整 SQL |