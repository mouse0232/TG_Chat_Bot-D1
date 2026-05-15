# 集成 AI 反骚扰功能 - 实现任务列表

## 任务概览

- **优先级**: P0（高优先级）
- **预估工期**: 3-4 天
- **依赖**: 本地反骚扰功能已完成（antiHarassment.js）

## 核心设计原则（已确认）

1. **AI 信任列表与黑白名单完全解耦** - `user_trust.trust_status` 仅控制是否跳过 AI 检测，`users.is_blocked` 控制消息放行，两者互不影响
2. **信任每日重置** - 第二天首次消息时归零计数，状态回到 new，需重新当日积累
3. **拉黑时无需清理 AI 信任** - 黑名单检查在流程前端，被拉黑用户消息不会到达 AI 检测环节

## 详细任务

### Phase 1: 基础模块开发（Day 1）

- [ ] **Task 1.1**: 创建 `src/security/aiSpamPrompt.js`
  - [ ] 定义 `SPAM_SYSTEM_PROMPT` 系统提示词
  - [ ] 定义 `SPAM_USER_PROMPT_TEMPLATE` 用户提示词模板
  - [ ] 实现 `fillPromptTemplate()` 模板变量替换函数

- [ ] **Task 1.2**: 创建 `src/security/aiAntiHarassment.js`
  - [ ] 实现 `checkAiSpam()` 函数
    - [ ] 总开关检查（`enable_ai_anti_harassment`）
    - [ ] AI 信任列表跳过检查（`trust_status === 'trusted'`，仅当日有效）
    - [ ] 非文本消息跳过逻辑
    - [ ] 构造 prompt 并调用 `callLlmApi()`
    - [ ] 解析 LLM 返回结果（SPAM:/CLEAN）
    - [ ] 超时/错误 fail-open 处理
  - [ ] 实现 `callLlmApi()` 函数
    - [ ] 使用原生 fetch API 调用 OpenAI Compatible API
    - [ ] AbortController 超时控制
    - [ ] Authorization header 设置
    - [ ] 错误处理与日志
  - [ ] 实现 `handleAiSpamIntercept()` 函数
    - [ ] 调用 `recordSpam()` 更新信任状态（当日计数归零）
    - [ ] 设置 `is_blocked = true`（进入项目黑名单）
    - [ ] 调用 `manageBlacklist()` 通知管理员
    - [ ] 发送拦截提示给用户
    - [ ] 发送 AI 分析报告到管理群组
    - [ ] 不清理 AI 信任状态（两者解耦）
  - [ ] 实现 `handleAiCleanPass()` 函数
    - [ ] 调用 `incrementCleanCount()` 增加当日通过计数（含每日重置逻辑）
    - [ ] 调用 `checkAndPromoteToWhitelist()` 检查是否达到当日阈值

- [ ] **Task 1.3**: 创建 `src/database/trust.js`
  - [ ] 实现 `getTodayDateStr()` UTC+8 日期字符串函数
  - [ ] 实现 `getUserTrust()` 查询用户信任信息
  - [ ] 实现 `createUserTrust()` 创建信任记录（含 last_clean_date）
  - [ ] 实现 `incrementCleanCount()` 增加当日连续通过次数
    - [ ] **关键**：检查 `last_clean_date` 是否跨天，跨天则归零计数+状态回 new
  - [ ] 实现 `recordSpam()` 记录垃圾消息（当日计数归零+状态转 monitoring）
  - [ ] 实现 `checkAndPromoteToWhitelist()` 检查当日阈值晋升
    - [ ] 仅检查 `consecutive_clean_count >= threshold`（无累计垃圾次数门槛）
  - [ ] 实现 `trustUser()` 手动信任用户
  - [ ] 实现 `untrustUser()` 取消信任用户

- [ ] **Task 1.4**: 更新 `src/utils/constants.js`
  - [ ] 新增 AI 反骚扰默认配置
    - [ ] `enable_ai_anti_harassment: "false"`
    - [ ] `ai_anti_harassment_trust_threshold: "3"`
    - [ ] `ai_anti_harassment_notify_auto_whitelist: "true"`

- [ ] **Task 1.5**: 更新 `src/database/index.js`
  - [ ] 在 `dbInit()` 中新增 `user_trust` 表创建
  - [ ] 定义表结构（含新增 `last_clean_date` 字段）

### Phase 2: 处理器集成（Day 2）

- [ ] **Task 2.1**: 修改 `src/handlers/private.js`
  - [ ] 导入 `aiAntiHarassment` 模块和 `trust.js` 模块
  - [ ] 在 `handleVerifiedMsg()` 中，本地反骚扰检测之后新增 AI 检测环节
    - [ ] 调用 `checkAiSpam()` 检测
    - [ ] SPAM 时调用 `handleAiSpamIntercept()`（拉黑+通知，不清理AI信任）
    - [ ] CLEAN 时调用 `handleAiCleanPass()` 更新当日信任（含每日重置）
    - [ ] 晋升成功时发送"加入AI信任列表"通知到管理群组

- [ ] **Task 2.2**: 修改 `src/handlers/adminReply.js`
  - [ ] 新增 `/trust` 命令识别与处理 → 加入AI信任列表
  - [ ] 新增 `/untrust` 命令识别与处理 → 移出AI信任列表

### Phase 3: 管理面板集成（Day 2-3）

- [ ] **Task 3.1**: 修改 `src/handlers/adminConfig.js`
  - [ ] 在管理面板新增 AI 反骚扰配置区域
    - [ ] AI 反骚扰总开关按钮
    - [ ] 信任阈值配置输入
    - [ ] 最大垃圾次数配置输入
    - [ ] 自动加白通知开关
  - [ ] 新增配置回调处理
    - [ ] 开关切换回调
    - [ ] 数值输入保存回调

- [ ] **Task 3.2**: 管理面板测试
  - [ ] 测试通过面板开启/关闭 AI 反骚扰
  - [ ] 测试配置参数修改与持久化
  - [ ] 测试配置值边界情况

### Phase 4: 测试与优化（Day 3-4）

- [ ] **Task 4.1**: 功能测试
  - [ ] AI 检测为 SPAM 的消息被拦截
  - [ ] AI 检测为 CLEAN 的消息正常转发
  - [ ] 白名单用户消息直接转发（不调用 AI API）
  - [ ] 连续通过 3 次 AI 检测后自动加入白名单
  - [ ] 发送垃圾消息后连续通过次数归零
  - [ ] `/trust` 命令手动加入白名单
  - [ ] `/untrust` 命令移出白名单
  - [ ] AI API 不可用时消息正常放行（fail-open）
  - [ ] AI API 调用超时时消息正常放行
  - [ ] 配置开关功能
  - [ ] 管理员收到垃圾消息 AI 分析报告
  - [ ] 与本地反骚扰功能兼容

- [ ] **Task 4.2**: 性能测试
  - [ ] 测量 AI 检测增加的延迟
  - [ ] 测试白名单跳过检测的零延迟
  - [ ] 测试超时场景下的响应时间
  - [ ] 验证 Workers CPU 时间限制内完成

- [ ] **Task 4.3**: 边界测试
  - [ ] 空文本消息跳过 AI 检测
  - [ ] 超长文本消息截断检测
  - [ ] LLM 返回格式异常时的处理
  - [ ] 并发消息的信任计数准确性
  - [ ] 无信任记录用户的首次检测流程

- [ ] **Task 4.4**: 代码审查与优化
  - [ ] 检查代码风格一致性
  - [ ] 检查错误处理完整性
  - [ ] 检查安全考虑（API Key 不泄露）
  - [ ] 检查性能影响

### Phase 5: 文档与部署（Day 4）

- [ ] **Task 5.1**: 更新项目文档
  - [ ] 更新 `REFACTOR.md` 新增 AI 反骚扰功能说明
  - [ ] 更新 `WORKFLOW.md` 新增 AI 检测流程图
  - [ ] 更新 `README.md` 新增环境变量说明（LLM_API/LLM_MODEL/LLM_KEY）

- [ ] **Task 5.2**: 部署验证
  - [ ] 配置 LLM 环境变量
  - [ ] 部署到测试环境
  - [ ] 开启 AI 反骚扰功能
  - [ ] 发送测试消息验证 AI 检测
  - [ ] 生产环境验证

## 验收标准

- [ ] 所有 Task 完成
- [ ] 所有测试用例通过
- [ ] 代码审查通过
- [ ] 文档更新完成
- [ ] 生产环境验证通过

## 关键行为验证

### AI 检测

| 场景 | 预期行为 |
|------|---------|
| 正常用户发送正常消息 | AI 检测 CLEAN → 正常转发 → 信任计数+1 |
| 正常用户发送垃圾消息 | AI 检测 SPAM → 拦截+拉黑+通知管理员 |
| 白名单用户发送消息 | 跳过 AI 检测 → 直接转发 |
| 非文本消息（图片/语音等） | 跳过 AI 检测 → 仅本地检测 |

### AI 信任系统

| 场景 | 预期行为 |
|------|---------|
| 新用户当日连续通过 3 次 AI 检测 | 加入 AI 信任列表（当日免检） |
| 第二天首次发消息 | 信任计数归零，状态回到 new，重新当日积累 |
| AI 信任用户被 /untrust | 移出 AI 信任列表，转为 monitoring |
| monitoring 用户当日连续通过 3 次 | 再次加入 AI 信任列表 |
| 管理员回复 /trust | 用户立即加入 AI 信任列表（当日免检） |
| AI 信任用户触发本地规则被拉黑 | 进入项目黑名单，AI 信任状态不受影响（两者解耦） |

### 解耦验证

| 场景 | 预期行为 |
|------|---------|
| 用户在 AI 信任列表中，被本地规则拉黑 | 消息被黑名单拦截（is_blocked），AI 信任状态保持 trusted |
| 管理员解封上述用户 | 消息恢复流转，因 AI 信任仍在 trusted → 跳过 AI 检测 |
| 第二天该用户首次消息 | AI 信任重置为 new，需重新当日积累 |

### 错误处理

| 场景 | 预期行为 |
|------|---------|
| LLM API 不可用 | fail-open → 消息正常转发 |
| LLM API 超时（>5s） | fail-open → 消息正常转发 |
| LLM 返回格式异常 | 视为 CLEAN → 消息转发 |

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| LLM API 成本过高 | 中 | 白名单系统减少调用量 + 默认关闭 |
| LLM 检测延迟影响用户体验 | 中 | 白名单跳过 + 超时 fail-open |
| LLM API 不可用 | 低 | fail-open 策略，不影响正常消息 |
| LLM 误判 | 中 | prompt 设计倾向于 CLEAN + 管理员可 /untrust |
| Workers CPU 时间超限 | 低 | 5s 超时 + fetch 不计 CPU |
| 与本地检测冲突 | 低 | 本地优先 + AI 第二层 |
| AI 信任列表与黑名单混淆 | 中 | 两者完全解耦 + 信任每日重置 |

## 相关文档

- [需求文档](./requirements.md)
- [技术设计文档](./design.md)
- [现有反骚扰功能需求](../anti-harassment/requirements.md)
- [现有反骚扰功能设计](../anti-harassment/design.md)
- [项目工作流](../../WORKFLOW.md)
- [重构说明](../../REFACTOR.md)
- [参考项目: telegram-watchdog](https://github.com/pupilcc/telegram-watchdog)