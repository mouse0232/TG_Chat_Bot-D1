/**
 * 常量与配置定义
 * 包含所有静态配置、默认值、安全参数和消息类型定义
 */

// 内存缓存配置
export const CACHE = {
  data: {},
  ts: 0,
  ttl: 60000,
  locks: new Set(), // isolate 内短 TTL 防抖（不用于分布式一致性）
  admin: {
    ts: 0,
    ttl: 60000,
    primarySet: new Set(),
    authSet: new Set()
  },
  // 清理节流：避免每个请求都触发清理
  cleanup: {
    processed_updates_ts: 0,
    ratelimits_ts: 0,
    messages_ts: 0
  }
};

// 默认配置值
export const DEFAULTS = {
  // 基础
  welcome_msg: "欢迎 {name}！请先完成验证。",

  // 验证
  enable_verify: "true",
  enable_qa_verify: "true",
  captcha_mode: "turnstile", // turnstile 或 recaptcha
  verif_q: "1+1=?\n提示：答案在简介中。",
  verif_a: "2",

  // 风控
  block_threshold: "5",
  enable_admin_receipt: "true", // 保留但不再使用（已按需求移除文字回执）

  // 转发开关
  enable_image_forwarding: "true",
  enable_link_forwarding: "true",
  enable_text_forwarding: "true",
  enable_channel_forwarding: "true",
  enable_forward_forwarding: "true",
  enable_audio_forwarding: "true",
  enable_sticker_forwarding: "true",

  // 话题与列表
  backup_group_id: "",
  unread_topic_id: "",
  blocked_topic_id: "",
  busy_mode: "false",
  busy_msg: "当前是非营业时间，消息已收到，管理员稍后回复。",
  block_keywords: "[]",
  keyword_responses: "[]",
  authorized_admins: "[]",

  // 反骚扰功能
  enable_anti_harassment: "true",
  anti_harassment_block_bot: "true",
  anti_harassment_block_no_username: "true",
  anti_harassment_allow_premium: "true",
  anti_harassment_block_bot_forward: "true",
  anti_harassment_block_inline_keyboard: "true",
  anti_harassment_block_mention: "true",

  enable_ai_anti_harassment: "false",
  ai_anti_harassment_trust_threshold: "3",
  ai_anti_harassment_notify_auto_whitelist: "true",

  enable_tencent_tms: "false",
  tencent_tms_trust_threshold: "3",
  tencent_tms_review_block_threshold: "60",
  tencent_tms_notify_auto_whitelist: "true"
};

// 已送达 reaction
export const DELIVERED_REACTION = "👍";

// 幂等/限流/锁参数
export const PROCESSED_UPDATES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
export const RATELIMIT_CLEANUP_TTL_MS = 10 * 60 * 1000; // ratelimits 仅保留 10min

// 私聊消息限流（跨实例）
export const RATELIMIT_USER_WINDOW_MS = 2000; // 2s
export const RATELIMIT_USER_MAX = 6; // 每用户 2s 最多 6 条
export const RATELIMIT_GLOBAL_WINDOW_MS = 10000; // 10s
export const RATELIMIT_GLOBAL_MAX = 250; // 全局 10s 最多 250 条

// /submit_token 限流（防滥用）
export const SUBMIT_RL_WINDOW_MS = 60000; // 60s
export const SUBMIT_RL_IP_MAX = 30; // 每 IP 每分钟最多 30 次（含失败）
export const SUBMIT_RL_UID_MAX = 10; // 每 uid 每分钟最多 10 次（含失败）

// 话题创建锁
export const TOPIC_LOCK_STALE_MS = 60 * 1000; // 话题创建锁 1min 视为过期
export const TOPIC_LOCK_POLL_MAX = 8; // 轮询次数减少
export const TOPIC_LOCK_POLL_BASE_MS = 160; // 指数退避 base

// 验证 nonce
export const VERIFY_NONCE_TTL_MS = 15 * 60 * 1000; // 15min

// messages TTL
export const MESSAGES_TTL_DAYS = 30;

// Regex 安全策略（ReDoS 缓解）
export const REGEX_MAX_PATTERN_LEN = 256;
export const REGEX_MAX_TEXT_LEN = 512; // 仅对前 512 字符做 regex test，降低灾难性回溯伤害
export const REGEX_REJECT_PATTERNS = [
  /\([^)]*\)\s*[+*{]/,
  /\(\s*\.\*\s*\)\s*\+/,
  /\(\s*\.\+\s*\)\s*\+/,
  /\\[1-9]/,
  /\(\?<=[\s\S]*\)/,
  /\(\?<![\s\S]*\)/
];

// 消息类型定义
export const MSG_TYPES = [
  {
    check: m => m.forward_from || m.forward_from_chat,
    key: "enable_forward_forwarding",
    name: "转发消息",
    extra: m => (m.forward_from_chat?.type === "channel" ? "enable_channel_forwarding" : null)
  },
  { check: m => m.audio || m.voice, key: "enable_audio_forwarding", name: "语音/音频" },
  { check: m => m.sticker || m.animation, key: "enable_sticker_forwarding", name: "贴纸/GIF" },
  { check: m => m.photo || m.video || m.document, key: "enable_image_forwarding", name: "媒体文件" },
  { check: m => (m.entities || []).some(e => ["url", "text_link"].includes(e.type)), key: "enable_link_forwarding", name: "链接" },
  { check: m => m.text, key: "enable_text_forwarding", name: "纯文本" }
];
