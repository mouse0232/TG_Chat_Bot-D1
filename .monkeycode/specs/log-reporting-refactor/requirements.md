# 对日志上报优化 - 需求文档

## 1. 需求概述

检查目前所有功能点，是否有错误上报日志机制。方便日后很好定位问题。目前日志上报代码是否合理，如果不合理提出重构方案。

## 2. 现状分析

### 2.1 日志调用统计

| 类型 | 数量 | 主要分布 |
|------|------|----------|
| console.log | 5 | antiHarassment(4), aiAntiHarassment(1) |
| console.error | 16 | index(1), router(1), adminConfig(8), relay(2), database(5), security(10) |
| console.warn | 2 | telegram.js(2) |
| 静默吞错 .catch(() => {}) | ~22 | handlers(17), services(6), security(5), helpers(2) |
| 空 catch {} | ~10 | private(2), tokenSubmit(1), database(3), commands(1), initData(1), regexGuard(1), inbox(1) |
| throw Error | ~19 | tokenSubmit(6), initData(4), telegram(3), tencentTms(3), aiAntiHarassment(2) |

### 2.2 核心问题

1. **日志格式完全不统一**：有的用 `[AntiHarassment]` 标签前缀，有的用裸字符串 `"DB Init Failed:"`，缺少时间戳、requestId、userId 等上下文
2. **关键错误被静默吞掉**：tokenSubmit 外层 catch 完全无声（所有验证失败一律返回 `{success:false}` + 400，无日志）；database/trust.js 全部 D1 操作无 try/catch
3. **.catch(() => {}) 滥用**：22+ 处静默吞错误，尤其 Telegram API 调用失败完全丢弃（如 answerCallbackQuery 失败导致用户点击按钮无反馈）
4. **console.error 混用 debug 信息**：adminConfig 用 console.error 输出 `[CHECK_AI] Starting connectivity check` 等 trace 信息
5. **SQL 日志泄露风险**：database/index.js 的 `SQL Fail [${query}]:` 输出完整 SQL 语句，可能含用户数据
6. **无请求链路追踪**：缺乏 request ID，无法串联一个请求在多模块间的完整日志链路
7. **无外部日志收集**：所有日志仅输出到 stdout/stderr，Worker 执行完毕后日志即丢失

## 3. 功能需求

### 3.1 验证场景需求

| ID | 需求描述 | EARS 模式 |
|----|----------|-----------|
| FR-01 | 系统应当提供统一的日志模块，所有模块通过统一接口输出日志 | 当系统需要输出日志时，系统应当通过 Logger 模块的统一接口输出 |
| FR-02 | 每条日志应当包含模块标签、日志级别、时间戳和结构化上下文 | 当系统输出日志时，每条日志应当包含 tag、level、timestamp、context 字段 |
| FR-03 | 系统应当为每个 HTTP 请求生成唯一 request ID，并传递到所有下游模块 | 当系统收到 HTTP 请求时，系统应当生成唯一 requestId 并在日志中附带 |
| FR-04 | 系统应当消除所有静默吞错误模式，所有 catch 应当至少输出 WARN 级别日志 | 当系统捕获异常时，系统应当至少输出 WARN 级别日志 |
| FR-05 | 系统应当区分业务异常和技术异常，分别记录不同级别日志 | 当系统捕获异常时，系统应当根据异常类型区分日志级别 |
| FR-06 | 系统应当对 SQL 日志脱敏，不输出完整 SQL 语句和用户数据 | 当数据库操作失败时，系统应当只输出操作类型和表名，参数脱敏 |
| FR-07 | 系统应当为关键操作（验证流程、消息转发、反骚扰检测）提供完整日志链路 | 当关键业务流程执行时，系统应当输出从入口到出口的完整日志链路 |

## 4. 非功能需求

| ID | 需求描述 |
|----|----------|
| NFR-01 | Logger 模块代码不超过 80 行，保持轻量 |
| NFR-02 | 日志重构不改变现有功能行为，100% 兼容 |
| NFR-03 | 日志模块零外部依赖，不引入第三方库 |
| NFR-04 | 性能开销：单次日志调用耗时不超过 0.1ms |
| NFR-05 | 兼容 Cloudflare Workers 运行时，支持 wrangler tail 实时查看 |
| NFR-06 | 兼容 Cloudflare Logpush 外部收集扩展 |

## 5. 约束条件

- 运行环境为 Cloudflare Workers，无文件系统，日志只能通过 console API 输出
- Worker 单次执行有 CPU 时间限制（免费版 10ms，付费版 30s），日志不能占用过多执行时间
- 项目使用纯 JavaScript（ES Modules），不使用 TypeScript