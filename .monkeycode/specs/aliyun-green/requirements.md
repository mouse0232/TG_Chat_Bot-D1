# 集成阿里云内容安全/机器审核增强版/文本审核 - 需求文档

## 1. 功能概述

在现有本地反骚扰检测的基础上，集成阿里云内容安全（Green）文本审核增强版大模型服务（出海版），实现对色情、暴恐、辱骂、赌博、涉政、引流等多语言骚扰内容的识别与拦截。Green 服务与 AI 反骚扰功能互斥（只能二选一），功能逻辑与 AI 反骚扰保持一致。此功能替换原腾讯 TMS（因不支持境外）。

## 2. 功能范围

### 2.1 本次实现范围

- 阿里云 Green API 集成：调用 TextModerationPlus 接口，使用 UGC场景文本审核大模型服务_出海版（ugc_moderation_byllm_cb），地域新加坡（ap-southeast-1）
- 信任列表系统：复用 AI 反骚扰的 user_trust 表和信任机制（每日重置、连续通过晋升）
- 与本地检测并存：本地规则优先拦截，通过后再进入 Green 检测
- 互斥控制：Green 与 AI 反骚扰只能二选一，开启 Green 时自动关闭 AI 反骚扰
- 管理员命令：复用 /trust /untrust 命令（信任列表为同一套）
- 管理面板：新增 Green 反骚扰配置开关，替换原 TMS 入口
- 多语言支持：出海版支持 119 种语言（中文、英文、西班牙语、法语、葡萄牙语、意大利语、阿拉伯语、日语、韩语、印度尼西亚语、俄语、越南语、德语和泰语等）

### 2.2 未来扩展

- 自定义词库集成（阿里云控制台配置，命中后返回 customized 标签）
- 切换国内版服务（ugc_moderation_byllm / ugc_moderation_byllm_pro）
- 审核结果统计与分析
- 账号上下文审核（accountId 参数，结合用户历史行为）

## 3. 核心设计原则

### 3.1 与 AI 反骚扰互斥

Green 反骚扰与 AI 反骚扰是两种不同的检测手段，只能二选一：

| 维度 | AI 反骚扰 | Green 反骚扰 |
|------|----------|-------------|
| 检测方式 | LLM API（大语言模型） | 阿里云 Green API（审核大模型） |
| 响应速度 | 1-5 秒 | 约 0.2-1.5 秒 |
| 识别能力 | 语义理解，灵活 | 大模型语义理解 + 119种语言 |
| 语言支持 | 取决于 LLM | 119种语言（出海版） |
| 境外支持 | 取决于 LLM 服务地域 | 新加坡地域，专为出海设计 |
| 成本 | LLM API 按 token 计费 | 20元/万次（按量） |
| 互斥关系 | enable_ai_anti_harassment | enable_aliyun_green |

**互斥保证**：开启 Green 时自动关闭 AI 反骚扰开关，反之亦然。两者不会同时生效。

### 3.2 信任列表共享

Green 反骚扰与 AI 反骚扰共享同一套信任列表系统（user_trust 表）：

| 维度 | 说明 |
|------|------|
| 存储位置 | 同一张 user_trust 表 |
| 信任机制 | 同一套：当日连续通过 N 次晋升、每日重置 |
| 管理命令 | 同一套：/trust /untrust |
| 信任免检 | 同一逻辑：trusted 用户跳过检测 |

无论使用 AI 还是 Green，信任列表的行为完全一致。切换检测方式时，信任数据不受影响。

### 3.3 信任每日重置

与 AI 反骚扰完全一致：
- 用户当天连续通过 N 次 Green 检测 → 进入信任列表（trusted）
- 第二天首次发消息时 → 信任计数归零，状态回到 new
- 信任列表与黑白名单完全解耦

### 3.4 替换腾讯 TMS

原腾讯 TMS 因不支持境外地域而弃用。Green 出海版以新加坡为地域，专为出海场景设计。替换后：
- TMS 代码保留但不启用（供参考）
- 配置开关从 enable_tencent_tms 切换到 enable_aliyun_green
- 管理面板入口从 TMS 替换为 Green
- 信任数据不受影响（共享同一套）

## 4. 详细需求

### 4.1 Green 垃圾信息检测

| 需求项 | 说明 |
|--------|------|
| 检测时机 | 本地反骚扰检测通过后，消息转发前 |
| 检测对象 | 仅非信任用户的文本消息 |
| 检测范围 | Green 出海版覆盖的全部违规类型：色情、低俗、涉政、种族主义、极端组织、武器弹药、毒品、赌博、辱骂、不良价值观、宗教亵渎、站外引流等 |
| 检测方式 | 调用阿里云 TextModerationPlus API，Service=ugc_moderation_byllm_cb |
| 使用地域 | 新加坡（ap-southeast-1） |
| 检测结果 | Green 返回 RiskLevel（high/medium/low/none）+ Result 数组（Label + Confidence + RiskWords） |
| 拦截判定 | RiskLevel 为 high → 拦截；RiskLevel 为 medium 且最高 Confidence >= 阈值 → 拦截；low/none → 放行 |
| 检测失败策略 | fail-open：Green 不可用时放行消息，记录错误日志 |
| 文本长度 | 最多 2000 字符，超出截断 |

**检测流程**：

```
用户消息 → 本地反骚扰检测 → 通过 → 黑名单检查 → 信任检查
                                                        ↓
                                                    trusted → 直接转发（跳过检测）
                                                    非trusted → Green 检测
                                                                ↓
                                                          RiskLevel=high → 拉黑+通知管理员
                                                          RiskLevel=medium + Confidence≥阈值 → 拉黑+通知管理员
                                                          RiskLevel=medium + Confidence<阈值 → 当日信任计数+1 → 转发
                                                          RiskLevel=low/none → 当日信任计数+1 → 转发
```

### 4.2 Green 响应映射

Green API 返回 RiskLevel 和 Result 数组（多标签），需要映射为项目可理解的原因：

**出海版风险标签映射**：

| Green Label | 映射原因 | RiskLevel 场景 | 动作 |
|-------------|----------|---------------|------|
| nonLabel | 未检出风险 | none | 放行，信任计数+1 |
| pornographic_adult | 色情内容 | high | 拦截 |
| sexual_terms | 性健康内容 | high | 拦截 |
| sexual_suggestive | 低俗内容 | high | 拦截 |
| sexual_orientation | 性取向内容 | high/medium | high→拦截，medium→视Confidence |
| regional_cn | 国内涉政内容 | high/medium | high→拦截，medium→视Confidence |
| regional_illegal | 非法政治内容 | high | 拦截 |
| regional_controversial | 政治争议 | high/medium | high→拦截，medium→视Confidence |
| regional_racism | 种族主义 | high | 拦截 |
| violent_extremist | 极端组织 | high | 拦截 |
| violent_incidents | 极端主义内容 | high | 拦截 |
| violent_weapons | 武器弹药 | high | 拦截 |
| violence_unscList | 联合国制裁名单 | high | 拦截 |
| contraband_drug | 毒品相关 | high | 拦截 |
| contraband_gambling | 赌博相关 | high | 拦截 |
| inappropriate_ethics | 不良价值观 | high/medium | high→拦截，medium→视Confidence |
| inappropriate_profanity | 攻击辱骂 | high | 拦截 |
| inappropriate_oral | 低俗口头语 | high/medium | high→拦截，medium→视Confidence |
| inappropriate_religion | 宗教亵渎 | high/medium | high→拦截，medium→视Confidence |
| pt_to_contact | 引流广告号 | high/medium | high→拦截，medium→视Confidence |
| pt_to_sites | 站外引流 | high/medium | high→拦截，medium→视Confidence |
| customized | 自定义违规 | high | 拦截（命中自定义词库） |

**RiskLevel 拦截判定规则**：

| RiskLevel | 动作 | 说明 |
|-----------|------|------|
| high | 拦截 | 高风险，建议直接处置 |
| medium | Confidence >= 阈值时拦截，否则放行 | 中风险，建议人工复查 |
| low | 放行 | 低风险，日常与 none 相同处理 |
| none | 放行 | 未检测到风险 |

**多标签处理**：Green 可能同时返回多个风险标签（如辱骂 + 低俗口头语同时命中）。管理员通知应列出所有命中标签及置信度分数。

### 4.3 互斥控制

| 场景 | 动作 |
|------|------|
| 开启 Green 反骚扰 | 自动关闭 AI 反骚扰（setConfig enable_ai_anti_harassment = false） |
| 开启 AI 反骚扰 | 自动关闭 Green 反骚扰（setConfig enable_aliyun_green = false） |
| 同时开启 | 不允许，管理面板互斥校验 + 连通性检测前置 |
| 两者都关闭 | 消息仅做本地检测，正常转发 |

### 4.4 配置项

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enable_aliyun_green` | boolean | `false` | Green 反骚扰总开关 |
| `aliyun_green_medium_block_threshold` | number | `80` | medium 风险拦截阈值（Confidence >= 此值时拦截） |
| `aliyun_green_trust_threshold` | number | `3` | 当日连续通过次数阈值（复用/共享信任表） |
| `aliyun_green_notify_auto_whitelist` | boolean | `true` | 自动加入信任列表时是否通知管理员 |

**环境变量**：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `ALIYUN_ACCESS_KEY_ID` | 阿里云 AccessKey ID | `LTAI5t...` |
| `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 AccessKey Secret | `xxx...` |
| `ALIYUN_GREEN_REGION` | Green API 地域 | `ap-southeast-1` |
| `ALIYUN_GREEN_SERVICE` | 检测服务类型 | `ugc_moderation_byllm_cb` |
| `ALIYUN_GREEN_TIMEOUT_MS` | Green API 调用超时（毫秒） | `5000` |

**注意**：信任阈值配置 `ai_anti_harassment_trust_threshold` 与 `aliyun_green_trust_threshold` 分别设置，但实际读取信任阈值时，根据当前启用的检测方式选择对应的配置键。两者默认值相同（3）。

### 4.5 垃圾信息拦截动作

| 场景 | 动作 |
|------|------|
| Green 检测为 high | 设置 is_blocked=true（进入项目黑名单），记录垃圾原因到 user_info，调用 manageBlacklist()，发送拦截提示 |
| Green 检测为 medium(>=阈值) | 同 high 动作 |
| 管理员收到通知 | 在管理群组转发垃圾消息 + Green 分析报告（含 RiskLevel、所有命中 Label/Confidence/RiskWords） |
| 用户收到提示 | "您的消息因包含垃圾信息已被过滤。如有疑问，请联系管理员。" |
| 信任列表影响 | Green 检测为 high/medium(>=阈值) 时，信任计数归零、状态转为 monitoring |

### 4.6 连通性检测

| 需求项 | 说明 |
|--------|------|
| 检测时机 | 管理员尝试开启 Green 时，或手动点击"检测连通性"按钮 |
| 检测方式 | 发送短文本（"test"），验证签名正确、密钥有效、API 可达、响应结构正确 |
| 检测内容 | 验证 ALIYUN_ACCESS_KEY_ID/SECRET 配置正确，签名计算无误，新加坡端点可达，RiskLevel 字段存在 |
| 开启前置条件 | 连通性检测通过后才允许开启 Green 反骚扰 |
| 失败提示 | 显示错误原因和修复建议（密钥未配置、签名错误、端点不可达等） |

## 5. 业务流程

### 5.1 完整消息处理流程

```
用户发送消息
    │
    ▼
┌───────────────────┐
│ 本地反骚扰检测      │
│ (checkUser/        │
│  checkMessage)     │
└─────────┬─────────┘
          │ 通过
          ▼
┌───────────────────┐     ┌───────────────────┐
│ 黑名单/限流检查    │────▶│ 触发 → 终止流程    │
└─────────┬─────────┘     └───────────────────┘
          │ 通过
          ▼
┌───────────────────┐
│ 反骚扰模式选择？    │
└─────────┬─────────┘
     ┌────┴────┐
     ▼         ▼         ▼
   两者关闭   AI模式     Green模式
     │         │         │
     ▼         ▼         ▼
   正常流程  AI检测流程  Green检测流程
                         (见下方)
```

### 5.2 Green 检测子流程

```
┌───────────────────┐
│ Green 总开关？      │
│ enable_aliyun_green │
└─────────┬─────────┘
     关闭        开启
      │          │
      ▼          ▼
   正常流程   ┌───────────────────┐
              │ 信任检查           │
              │ (trust_status)    │
              │ + 每日重置         │
              └─────────┬─────────┘
                   ┌────┴────┐
                   ▼         ▼
               trusted     非trusted
               (当日免检)     │
                   │         ▼
                   ▼     ┌───────────────────┐
               直接转发   │ Green 文本检测        │
                         │ (TextModerationPlus) │
                         │ Service=             │
                         │ ugc_moderation_byllm │
                         │ _cb                  │
                         │ Region=              │
                         │ ap-southeast-1       │
                         └─────────┬─────────┘
                              ┌────┴────┐
                              ▼         ▼          ▼
                           none/low   medium      high
                              │     (Confidence    │
                              │      >=阈值拦截)   │
                              ▼         ▼          ▼
                          当日信任   项目黑名单   项目黑名单
                          计数+1    +信任归零     +信任归零
                              │       +通知      +通知
                         ┌────┴────┐
                         ▼         ▼
                     达到阈值     未达阈值
                         │         │
                         ▼         ▼
                     当日免检     正常转发
                     (trusted)
```

## 6. 非功能需求

### 6.1 性能要求

- Green API 调用超时上限 5 秒，超时后 fail-open
- Green 响应速度预期 0.2-1.5 秒（大模型审核版），优于 AI 反骚扰的 1-5s
- 首次请求可能较慢（冷启动约 1-1.5s），后续请求约 0.2-0.5s
- 信任用户不受 Green 检测延迟影响
- 本地检测优先拦截，减少不必要的 Green API 调用
- Green API 单用户 QPS 限制 50次/秒，远超实际需求

### 6.2 成本控制

- 信任列表系统大幅减少 Green API 调用量
- 仅文本消息触发 Green 检测
- 仅非信任用户触发 Green 检测
- 阿里云按量计费：20元/万次
- 也可购买资源包（抵扣系数 2.67）

### 6.3 可靠性

- Green API 不可用时 fail-open，不阻断正常消息
- Green 检测错误不影响本地反骚扰功能
- 信任数据持久化到 D1（与 AI 反骚扰共享）
- 连通性检测作为开启前置条件

### 6.4 兼容性

- 与本地反骚扰检测并存，本地优先
- 与 AI 反骚扰互斥，不能同时启用
- 与项目黑白名单系统完全解耦
- 与现有管理面板兼容
- Cloudflare Workers 环境兼容（使用 fetch API + 手动 HMAC-SHA1 签名）
- Web Crypto API 支持 HMAC-SHA1 签名计算（Workers 提供 crypto.subtle）
- 文本截断至 2000 字符（Green API 限制）

### 6.5 安全性

- 阿里云密钥通过 Workers Secrets 管理，不硬编码
- HMAC-SHA1 签名防止请求篡改
- SignatureNonce 防止重放攻击
- Timestamp 防止签名过期使用
- 不在日志中输出密钥内容

## 7. 已知限制

### 7.1 出海版广告检测

实测发现出海版（ugc_moderation_byllm_cb）对中文广告/引流内容的检测敏感度偏低。典型中文广告文本（如"限时优惠！加微信免费领取"）可能返回 RiskLevel=none。

**缓解方案**：
- 本地反骚扰层补充广告关键词规则
- 未来可考虑切换到国内版服务（需使用国内地域）
- 管理员可通过自定义词库增强检测

### 7.2 文本长度限制

Green API 限制文本不超过 2000 字符，超出部分将被截断。长文本的尾部内容不会被检测。

### 7.3 响应延迟

大模型审核版响应比传统审核版（毫秒级）慢，但优于 AI 反骚扰（LLM API 1-5s）。冷启动请求可能延迟 1-1.5s。

## 8. 验收标准

- [ ] Green 检测为 high 的消息被拦截，用户进入项目黑名单
- [ ] Green 检测为 medium 且 Confidence >= 阈值 的消息被拦截
- [ ] Green 检测为 medium 且 Confidence < 阈值 的消息正常转发
- [ ] Green 检测为 low/none 的消息正常转发
- [ ] 信任用户当日消息直接转发，不调用 Green API
- [ ] 当日连续通过 N 次 Green 检测后进入信任列表
- [ ] 第二天首次发消息时信任计数归零，状态回到 new
- [ ] 开启 Green 时自动关闭 AI 反骚扰
- [ ] 开启 AI 反骚扰时自动关闭 Green
- [ ] 两者不能同时开启（管理面板互斥校验）
- [ ] /trust /untrust 命令在 Green 模式下正常工作
- [ ] Green API 不可用时消息正常放行（fail-open）
- [ ] Green API 调用超时时消息正常放行
- [ ] 可通过配置开启/关闭 Green 反骚扰功能
- [ ] 管理员收到垃圾消息分析报告（含 RiskLevel、所有命中 Label/Confidence/RiskWords）
- [ ] 与本地反骚扰功能无冲突
- [ ] 信任列表与项目黑白名单互不影响（解耦验证）
- [ ] 连通性检测功能正常工作（密钥校验 + 端点可达 + 响应结构验证）
- [ ] 多语言文本检测正常工作（中/英/日等）
- [ ] 非文本消息跳过 Green 检测
- [ ] 文本超过 2000 字符时正确截断