# 反骚扰功能 - 实现任务列表

## 任务概览

- **优先级**: P0（高优先级）
- **预估工期**: 2-3 天
- **依赖**: 无（基于现有架构扩展）

## 详细任务

### Phase 1: 核心模块开发（Day 1）

- [ ] **Task 1.1**: 创建 `src/security/antiHarassment.js`
  - [ ] 实现 `checkUser()` 函数（用户身份检测）
    - [ ] 检测 `is_bot === true`
    - [ ] 检测 `username` 为空
    - [ ] 检测 `is_premium === true`（放行逻辑）
    - [ ] 配置项读取与缓存
  - [ ] 实现 `checkMessage()` 函数（消息内容检测）
    - [ ] 检测 `forward_from.is_bot === true`
    - [ ] 检测 `reply_markup.inline_keyboard` 存在
    - [ ] 配置项读取与缓存
  - [ ] 实现 `handleUserIntercept()` 函数（用户身份拦截）
    - [ ] 发送提示消息："❌ 您不符合聊天对象要求，无法使用本 Bot。"
    - [ ] **不拉黑**，不调用 `manageBlacklist()`
  - [ ] 实现 `handleMessageIntercept()` 函数（消息内容拦截）
    - [ ] 发送提示消息："❌ 您不符合聊天对象要求，无法使用本 Bot。"
    - [ ] **拉黑用户**：设置 `is_blocked = true`
    - [ ] **通知管理员**：调用 `manageBlacklist()`
    - [ ] 记录拉黑原因到 `user_info`
  - [ ] 添加错误处理和日志记录

- [ ] **Task 1.2**: 更新 `src/utils/constants.js`
  - [ ] 新增反骚扰相关默认配置项
    - [ ] `enable_anti_harassment: "true"`
    - [ ] `anti_harassment_block_bot: "true"`
    - [ ] `anti_harassment_block_no_username: "true"`
    - [ ] `anti_harassment_allow_premium: "true"`
    - [ ] `anti_harassment_block_bot_forward: "true"`
    - [ ] `anti_harassment_block_inline_keyboard: "true"`
    - [ ] `anti_harassment_block_mention: "true"`

### Phase 2: 集成与测试（Day 1-2）

- [ ] **Task 2.1**: 修改 `src/handlers/private.js`
  - [ ] 在 `handlePrivate()` 函数开头集成用户身份检测
    - [ ] 导入 `antiHarassment` 模块
    - [ ] 调用 `checkUser()` 检测
    - [ ] 触发时调用 `handleUserIntercept(id, reason, env)`（**不拉黑**）
  - [ ] 在 `handleVerifiedMsg()` 函数开头集成消息内容检测
    - [ ] 调用 `checkMessage()` 检测
    - [ ] 触发时调用 `handleMessageIntercept(id, msg.from, reason, env)`（**拉黑**）
  - [ ] 确保管理员不受检测影响

- [ ] **Task 2.2**: 功能测试
  - [ ] 测试机器人账号被拦截（**不进入黑名单**）
  - [ ] 测试空用户名用户被拦截（**不进入黑名单**）
  - [ ] 测试 Premium 用户放行
  - [ ] 测试 Bot 转发消息被拦截（已验证用户，**进入黑名单**）
  - [ ] 测试带内联键盘消息被拦截（已验证用户，**进入黑名单**）
  - [ ] 测试包含 @提及 消息被拦截（已验证用户，**进入黑名单**）
  - [ ] 测试配置开关功能

### Phase 3: 管理面板集成（Day 2）

- [ ] **Task 3.1**: 修改 `src/handlers/adminConfig.js`
  - [ ] 在管理面板添加反骚扰配置区域
  - [ ] 添加各检测规则的开关按钮
  - [ ] 添加总开关按钮

- [ ] **Task 3.2**: 管理面板测试
  - [ ] 测试通过面板开启/关闭功能
  - [ ] 测试配置持久化

### Phase 4: 文档与部署（Day 2-3）

- [ ] **Task 4.1**: 更新项目文档
  - [ ] 更新 `REFACTOR.md` 功能清单
  - [ ] 更新 `README.md` 添加反骚扰功能说明

- [ ] **Task 4.2**: 代码审查与优化
  - [ ] 检查代码风格一致性
  - [ ] 检查错误处理完整性
  - [ ] 检查性能影响

- [ ] **Task 4.3**: 部署验证
  - [ ] 本地测试通过
  - [ ] 部署到测试环境
  - [ ] 生产环境验证

## 验收标准

- [ ] 所有 Task 完成
- [ ] 所有测试用例通过
- [ ] 代码审查通过
- [ ] 文档更新完成
- [ ] 生产环境验证通过

## 关键行为验证

### 用户身份检测

| 场景 | 预期行为 |
|------|---------|
| 机器人账号发送 /start | 提示"不符合聊天对象"，**不进入黑名单** |
| 空用户名用户发送消息 | 提示"不符合聊天对象"，**不进入黑名单** |
| Premium 用户发送消息 | 正常通过，进入验证流程 |

### 消息内容检测

| 场景 | 预期行为 |
|------|---------|
| 已验证用户转发 Bot 消息 | 提示"不符合聊天对象"，**进入黑名单** |
| 已验证用户发送带内联键盘消息 | 提示"不符合聊天对象"，**进入黑名单** |
| 已验证用户发送包含 @提及 消息 | 提示"不符合聊天对象"，**进入黑名单** |

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 误拦截正常用户 | 高 | Premium 白名单 + 可配置开关 |
| 性能下降 | 中 | 同步检测 + 配置缓存 |
| 与现有功能冲突 | 中 | 充分测试验证流程、黑名单、管理面板 |
| 配置不生效 | 低 | 使用现有配置系统，确保兼容性 |

## 相关文档

- [需求文档](./requirements.md)
- [技术设计文档](./design.md)
- [项目工作流](../../WORKFLOW.md)
- [重构说明](../../REFACTOR.md)
