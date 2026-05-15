/**
 * 管理面板处理器
 */

import { api } from '../api/telegram.js';
import { getConfig, setConfig, getBoolConfig, getJsonConfig } from '../database/config.js';
import { sql } from '../database/index.js';
import { escapeHTML, safeParse } from '../utils/helpers.js';
import { checkAiConnectivity, checkTmsConnectivity } from '../security/connectivityCheck.js';

/**
 * 处理管理面板
 * @param {string} cid - 聊天 ID
 * @param {number|null} mid - 消息 ID
 * @param {string} type - 操作类型
 * @param {string|null} key - 配置键
 * @param {string|null} val - 配置值
 * @param {Object} env - 环境变量
 */
export async function handleAdminConfig(cid, mid, type, key, val, env) {
  const render = (txt, kb) =>
    api(env.BOT_TOKEN, mid ? "editMessageText" : "sendMessage", {
      chat_id: cid,
      message_id: mid,
      text: txt,
      parse_mode: "HTML",
      reply_markup: kb
    });
  const back = { text: "🔙 返回", callback_data: "config:menu" };

  try {
    if (!type || type === "menu") {
      if (!key)
        return render("⚙️ <b>控制面板</b>", {
          inline_keyboard: [
            [{ text: "📝 基础", callback_data: "config:menu:base" }, { text: "🤖 自动回复", callback_data: "config:menu:ar" }],
            [{ text: "🚫 屏蔽词", callback_data: "config:menu:kw" }, { text: "🛠 过滤", callback_data: "config:menu:fl" }],
            [{ text: "👮 协管", callback_data: "config:menu:auth" }, { text: "💾 备份/通知", callback_data: "config:menu:bak" }],
            [{ text: "\u{1F319} \u8425\u4E1A\u72B6\u6001", callback_data: "config:menu:busy" }, { text: "\u{1F6E1} \u53CD\u9A9A\u6311", callback_data: "config:menu:ah" }],
            [{ text: "\u{1F916} AI\u53CD\u9A9A\u6311", callback_data: "config:menu:aiah" }, { text: "\u{1F6E1} TMS\u53CD\u9A9A\u6311", callback_data: "config:menu:tms" }]
          ]
        });

      if (key === "base") {
        const mode = await getConfig("captcha_mode", env);
        const captchaOn = await getBoolConfig("enable_verify", env);
        const qaOn = await getBoolConfig("enable_qa_verify", env);
        let statusText = "❌ 已关闭";
        if (captchaOn) statusText = mode === "recaptcha" ? "Google" : "Cloudflare";

        return render(`基础配置\n验证码模式: ${statusText}\n问题验证: ${qaOn ? "✅" : "❌"}`, {
          inline_keyboard: [
            [{ text: "欢迎语", callback_data: "config:edit:welcome_msg" }, { text: "问题", callback_data: "config:edit:verif_q" }, { text: "答案", callback_data: "config:edit:verif_a" }],
            [{ text: `验证码模式: ${statusText} (点击切换)`, callback_data: `config:rotate_mode` }],
            [{ text: `问题验证: ${qaOn ? "✅ 开启" : "❌ 关闭"}`, callback_data: `config:toggle:enable_qa_verify:${!qaOn}` }],
            [back]
          ]
        });
      }

      if (key === "fl") return render("🛠 <b>过滤设置</b> (点击切换)", await getFilterKB(env));
      if (["ar", "kw", "auth"].includes(key)) {
        const titleMap = { ar: "🤖 自动回复规则", kw: "🚫 屏蔽词列表", auth: "👮 协管列表" };
        return render(titleMap[key] || `列表: ${key}`, await getListKB(key, env));
      }

      if (key === "bak") {
        const bid = await getConfig("backup_group_id", env);
        const uid = await getConfig("unread_topic_id", env);
        const blk = await getConfig("blocked_topic_id", env);
        return render(`💾 <b>备份与通知</b>\n备份群: ${bid || "无"}\n未读话题: ${uid ? `✅ (${uid})` : "⏳"}\n黑名单话题: ${blk ? `✅ (${blk})` : "⏳"}`, {
          inline_keyboard: [
            [{ text: "设备份群", callback_data: "config:edit:backup_group_id" }, { text: "清备份", callback_data: "config:cl:backup_group_id" }],
            [{ text: "重置聚合话题", callback_data: "config:cl:unread_topic_id" }, { text: "重置黑名单", callback_data: "config:cl:blocked_topic_id" }],
            [back]
          ]
        });
      }

      if (key === "busy") {
        const on = await getBoolConfig("busy_mode", env);
        const msgText = await getConfig("busy_msg", env);
        return render(`🌙 <b>营业状态</b>\n当前: ${on ? "🔴 休息中" : "🟢 营业中"}\n回复语: ${escapeHTML(msgText)}`, {
          inline_keyboard: [
            [{ text: `切换为 ${on ? "🟢 营业" : "🔴 休息"}`, callback_data: `config:toggle:busy_mode:${!on}` }],
            [{ text: "✏️ 修改回复语", callback_data: "config:edit:busy_msg" }],
            [back]
          ]
        });
      }

      if (key === "ah") {
        const enabled = await getBoolConfig("enable_anti_harassment", env);
        const blockBot = await getBoolConfig("anti_harassment_block_bot", env);
        const blockNoUname = await getBoolConfig("anti_harassment_block_no_username", env);
        const allowPremium = await getBoolConfig("anti_harassment_allow_premium", env);
        const blockBotFwd = await getBoolConfig("anti_harassment_block_bot_forward", env);
        const blockInline = await getBoolConfig("anti_harassment_block_inline_keyboard", env);
        const blockMention = await getBoolConfig("anti_harassment_block_mention", env);
        const t = (v) => v ? "✅" : "❌";
        return render(`🛡 <b>本地反骚扰检测</b>\n总开关: ${t(enabled)}\n\n<b>用户身份检测</b> (触发提示，不拉黑)\nBot账号: ${t(blockBot)}\n空用户名: ${t(blockNoUname)}\nPremium放行: ${t(allowPremium)}\n\n<b>消息内容检测</b> (触发提示+拉黑)\nBot转发: ${t(blockBotFwd)}\n内联键盘: ${t(blockInline)}\n@提及: ${t(blockMention)}`, {
          inline_keyboard: [
            [{ text: `总开关: ${t(enabled)}`, callback_data: `config:toggle:enable_anti_harassment:${!enabled}` }],
            [{ text: `Bot账号: ${t(blockBot)}`, callback_data: `config:toggle:anti_harassment_block_bot:${!blockBot}` }, { text: `空用户名: ${t(blockNoUname)}`, callback_data: `config:toggle:anti_harassment_block_no_username:${!blockNoUname}` }],
            [{ text: `Premium放行: ${t(allowPremium)}`, callback_data: `config:toggle:anti_harassment_allow_premium:${!allowPremium}` }],
            [{ text: `Bot转发: ${t(blockBotFwd)}`, callback_data: `config:toggle:anti_harassment_block_bot_forward:${!blockBotFwd}` }, { text: `内联键盘: ${t(blockInline)}`, callback_data: `config:toggle:anti_harassment_block_inline_keyboard:${!blockInline}` }],
            [{ text: `@提及: ${t(blockMention)}`, callback_data: `config:toggle:anti_harassment_block_mention:${!blockMention}` }],
            [back]
          ]
        });
      }

      if (key === "aiah") {
        const aiEnabled = await getBoolConfig("enable_ai_anti_harassment", env);
        const threshold = await getConfig("ai_anti_harassment_trust_threshold", env) || 3;
        const notifyAuto = await getBoolConfig("ai_anti_harassment_notify_auto_whitelist", env);
        const t = (v) => v ? "✅" : "❌";
        const llmReady = !!env.LLM_KEY;
        const llmStatus = llmReady ? "✅ 已配置" : "❌ 未配置 LLM_KEY";
        return render(`\u{1F916} <b>AI 反骚扰检测</b>\n总开关: ${t(aiEnabled)}\nLLM 配置: ${llmStatus}\n信任阈值: 当日连续通过 ${threshold} 次\n加信通知: ${t(notifyAuto)}\n\n<b>说明</b>\n- AI信任列表与黑白名单<b>完全独立</b>\n- 信任仅<b>当日有效</b>，第二天重置\n- /trust /untrust 在话题中回复使用${!llmReady ? "\n\n\u26A0\uFE0F <b>请先配置 LLM_KEY 环境变量再开启</b>" : ""}`, {
          inline_keyboard: [
            [{ text: `总开关: ${t(aiEnabled)}${!llmReady && !aiEnabled ? " (需先配置LLM)" : ""}`, callback_data: `config:toggle:enable_ai_anti_harassment:${!aiEnabled}` }],
            [{ text: `信任阈值: ${threshold}`, callback_data: `config:edit:ai_anti_harassment_trust_threshold` }],
            [{ text: `加信通知: ${t(notifyAuto)}`, callback_data: `config:toggle:ai_anti_harassment_notify_auto_whitelist:${!notifyAuto}` }],
            [{ text: "\u{1F50D} \u68C0\u6D4B\u8FDE\u901A\u6027", callback_data: "config:check_ai" }],
            [back]
          ]
        });
}
      }

      if (key === "tms") {
        const tmsEnabled = await getBoolConfig("enable_tencent_tms", env);
        const threshold = await getConfig("tencent_tms_trust_threshold", env) || 3;
        const notifyAuto = await getBoolConfig("tencent_tms_notify_auto_whitelist", env);
        const reviewThreshold = await getConfig("tencent_tms_review_block_threshold", env) || 60;
        const t = (v) => v ? "✅" : "❌";
        const secretReady = !!env.TENCENT_SECRET_ID && !!env.TENCENT_SECRET_KEY;
        const secretStatus = secretReady ? "✅ 已配置" : "❌ 未配置密钥";
        return render(`🛡 <b>TMS 反骚扰检测</b>\n总开关: ${t(tmsEnabled)}\n密钥配置: ${secretStatus}\n信任阈值: 当日连续通过 ${threshold} 次\nReview拦截阈值: Score >= ${reviewThreshold}\n加信通知: ${t(notifyAuto)}\n\n<b>说明</b>\n- 腾讯TMS毫秒级响应，延时远低于AI\n- 与AI反骚扰<b>互斥</b>，开启TMS自动关闭AI\n- 信任列表与AI共享<b>同一套</b>${!secretReady ? "\n\n⚠️ <b>请先配置密钥再开启</b>" : ""}`, {
          inline_keyboard: [
            [{ text: `总开关: ${t(tmsEnabled)}${!secretReady && !tmsEnabled ? " (需先配置密钥)" : ""}`, callback_data: `config:toggle:enable_tencent_tms:${!tmsEnabled}` }],
            [{ text: `信任阈值: ${threshold}`, callback_data: `config:edit:tencent_tms_trust_threshold` }],
            [{ text: `Review阈值: ${reviewThreshold}`, callback_data: `config:edit:tencent_tms_review_block_threshold` }],
            [{ text: `加信通知: ${t(notifyAuto)}`, callback_data: `config:toggle:tencent_tms_notify_auto_whitelist:${!notifyAuto}` }],
            [{ text: "🔍 检测连通性", callback_data: "config:check_tms" }],
            [back]
          ]
        });
      }
    }
        return render(`\u{1F916} AI \u8FDE\u901A\u6027\u68C0\u6D4B\n\n\u2717 \u8FDE\u901A\u5931\u8D25\n\u5EF6\u65F6: ${result.latencyMs}ms\n\u9519\u8BEF: ${escapeHTML(result.error || "")}\n\n<b>\u5EFA\u8BAE</b>:\n1. \u68C0\u67E5 LLM_KEY \u662F\u5426\u6709\u6548\n2. \u68C0\u67E5 LLM_API \u5730\u5740\u662F\u5426\u6B63\u786E\n3. \u7528 curl \u6D4B\u8BD5 API \u53EF\u8FDE\u901A`, {
          inline_keyboard: [[{ text: "\u{1F916} AI\u53CD\u9A9A\u6311", callback_data: "config:menu:aiah" }]]
        });
      }

      if (key === "tms") {
        const result = await checkTmsConnectivity(env);
        if (result.ok) {
          const detail = result.label ? `\nLabel: ${result.label}\nSuggestion: ${result.suggestion}` : "";
          return render(`\u{1F6E1} TMS \u8FDE\u901A\u6027\u68C0\u6D4B\n\n\u2713 \u8FDE\u901A\u6210\u529A\n\u5EF6\u65F6: ${result.latencyMs}ms${detail}\nTMS API \u53EF\u6B63\u5E38\u8C03\u7528`, {
            inline_keyboard: [[{ text: "\u{1F6E1} TMS\u53CD\u9A9A\u6311", callback_data: "config:menu:tms" }]]
          });
        }
        return render(`\u{1F6E1} TMS \u8FDE\u901A\u6027\u68C0\u6D4B\n\n\u2717 \u8FDE\u901A\u5931\u8D25\n\u5EF6\u65F6: ${result.latencyMs}ms\n\u9519\u8BEF: ${escapeHTML(result.error || "")}\n\n<b>\u5EFA\u8BAE</b>:\n1. \u68C0\u67E5 TENCENT_SECRET_ID/KEY \u662F\u5426\u6B63\u786E\n2. \u786E\u8BA4\u817E\u8BAF\u4E91 TMS \u670D\u52A1\u5DF2\u5F00\u901A\n3. \u68C0\u67E5 TENCENT_TMS_REGION \u503C\u662F\u5426\u6B63\u786E`, {
          inline_keyboard: [[{ text: "\u{1F6E1} TMS\u53CD\u9A9A\u6311", callback_data: "config:menu:tms" }]]
        });
      }
    }
        return render(`\u{1F916} AI \u8FDE\u901A\u6027\u68C0\u6D4B\n\n\u2717 \u8FDE\u901A\u5931\u8D25\n\u5EF6\u65F6: ${result.latencyMs}ms\n\u9519\u8BEF: ${escapeHTML(result.error || "")}\n\n<b>\u5EFA\u8BAE</b>:\n1. \u68C0\u67E5 LLM_KEY \u662F\u7528\u5230\u5230\u6709\u6548\n2. \u68C0\u67E5 LLM_API \u5730\u5740\u7528\u5230\u6700\u786C\n3. \u7528 curl \u6D4B\u8BD5 API \u53EF\u8C03\u7528`, {
          inline_keyboard: [[{ text: "\u{1F916} \u53CD\u9A9A\u6311", callback_data: "config:menu:aiah" }]]
        });
      }

      if (key === "tms") {
        const result = await checkTmsConnectivity(env);
        if (result.ok) {
          const detail = result.label ? `\nLabel: ${result.label}\nSuggestion: ${result.suggestion}` : "";
          return render(`\u{1F6E1} TMS \u8FDE\u901A\u6027\u68C0\u6D4B\n\n\u2713 \u8FDE\u901A\u6210\u529A\n\u5EF6\u65F6: ${result.latencyMs}ms${detail}\n\u8C03\u8FDE\u8FDE\u5DF2\u5230\u5230\u8C03\u7528`, {
            inline_keyboard: [[{ text: "\u{1F6E1} TMS\u53CD\u9A9A\u6311", callback_data: "config:menu:tms" }]]
          });
        }
        return render(`\u{1F6E1} TMS \u8FDE\u901A\u6027\u68C0\u6D4B\n\n\u2717 \u8FDE\u901A\u5931\u8D25\n\u5EF6\u65F6: ${result.latencyMs}ms\n\u9519\u8BE4: ${escapeHTML(result.error || "")}\n\n<b>\u5EFA\u8BAF</b>:\n1. \u68C0\u67E5 TENCENT_SECRET_ID/KEY \u7528\u5230\u5230\u6708\u786C\n2. \u786E\u8BA4\u8C13\u8FDE\u8FDE\u8FDE\u8FDE\u8FDE\u8FDE TMS \u7528\u5230\u5230\u5DF2\u5F00\u901A\n3. \u68C0\u67E5 TENCENT_TMS_REGION \u8FDE\u8FDE\u503C\u7528\u5230\u5230\u786C`, {
          inline_keyboard: [[{ text: "\u{1F6E1} TMS\u53CD\u9A9A\u6311", callback_data: "config:menu:tms" }]]
        });
      }
    }

    if (type === "toggle") {
      if (key === "enable_ai_anti_harassment" && val === "true" && !env.LLM_KEY) {
        return render("❌ <b>无法开启 AI 反骚扰</b>\n\n未配置 LLM 环境变量。\n请在 Cloudflare Dashboard 或 wrangler secret 中设置以下变量后重试：\n\n<b>必需</b>:\n• LLM_KEY — LLM API Key\n\n<b>可选</b>:\n• LLM_API — API Base URL (默认 OpenAI)\n• LLM_MODEL — 模型名称 (默认 gpt-4o-mini)\n• LLM_TIMEOUT_MS — 超时毫秒数 (默认 5000)", {
          inline_keyboard: [[{ text: "🔙 返回 AI 反骚扰", callback_data: "config:menu:aiah" }]]
        });
      }
      if (key === "enable_ai_anti_harassment" && val === "true") {
        const check = await checkAiConnectivity(env);
        if (!check.ok) {
          return render(`❌ <b>AI 反骚扰连通性检测失败</b>\n\n无法开启，LLM API 不可达。\n延时: ${check.latencyMs}ms\n错误: ${escapeHTML(check.error || "")}\n\n请先修复连通性问题再开启。`, {
            inline_keyboard: [[{ text: "🔙 返回 AI 反骚扰", callback_data: "config:menu:aiah" }]]
          });
        }
      }
      if (key === "enable_tencent_tms" && val === "true" && (!env.TENCENT_SECRET_ID || !env.TENCENT_SECRET_KEY)) {
        return render("❌ <b>无法开启 TMS 反骚扰</b>\n\n未配置腾讯云密钥。\n请在 Cloudflare Dashboard 或 wrangler secret 中设置以下变量后重试：\n\n<b>必需</b>:\n• TENCENT_SECRET_ID — 腾讯云 API SecretId\n• TENCENT_SECRET_KEY — 腾讯云 API SecretKey\n\n<b>可选</b>:\n• TENCENT_TMS_REGION — API 地域 (默认 ap-guangzhou)\n• TENCENT_TMS_TIMEOUT_MS — 超时毫秒数 (默认 3000)", {
          inline_keyboard: [[{ text: "🔙 返回 TMS 反骚扰", callback_data: "config:menu:tms" }]]
        });
      }
      if (key === "enable_tencent_tms" && val === "true") {
        const check = await checkTmsConnectivity(env);
        if (!check.ok) {
          return render(`❌ <b>TMS 反骚扰连通性检测失败</b>\n\n无法开启，TMS API 不可达。\n延时: ${check.latencyMs}ms\n错误: ${escapeHTML(check.error || "")}\n\n请先修复连通性问题再开启。`, {
            inline_keyboard: [[{ text: "🔙 返回 TMS 反骚扰", callback_data: "config:menu:tms" }]]
        });
        }
      }
      await setConfig(key, val, env);
      if (key === "enable_tencent_tms" && val === "true") await setConfig("enable_ai_anti_harassment", "false", env);
      if (key === "enable_ai_anti_harassment" && val === "true") await setConfig("enable_tencent_tms", "false", env);
      const ahKeys = ["enable_anti_harassment", "anti_harassment_block_bot", "anti_harassment_block_no_username", "anti_harassment_allow_premium", "anti_harassment_block_bot_forward", "anti_harassment_block_inline_keyboard", "anti_harassment_block_mention"];
      const aiAhKeys = ["enable_ai_anti_harassment", "ai_anti_harassment_notify_auto_whitelist"];
      const tmsKeys = ["enable_tencent_tms", "tencent_tms_notify_auto_whitelist"];
      if (key === "busy_mode") return handleAdminConfig(cid, mid, "menu", "busy", null, env);
      if (key === "enable_qa_verify") return handleAdminConfig(cid, mid, "menu", "base", null, env);
      if (ahKeys.includes(key)) return handleAdminConfig(cid, mid, "menu", "ah", null, env);
      if (aiAhKeys.includes(key)) return handleAdminConfig(cid, mid, "menu", "aiah", null, env);
      if (tmsKeys.includes(key)) return handleAdminConfig(cid, mid, "menu", "tms", null, env);
      return render("🛠 <b>过滤设置</b>", await getFilterKB(env));
    }

    if (type === "cl") {
      await setConfig(key, key === "authorized_admins" ? "[]" : "", env);
      return handleAdminConfig(
        cid,
        mid,
        "menu",
        key === "unread_topic_id" || key === "blocked_topic_id" ? "bak" : key === "authorized_admins" ? "auth" : "bak",
        null,
        env
      );
    }

    if (type === "del") {
      const realK = key === "kw" ? "block_keywords" : key === "auth" ? "authorized_admins" : "keyword_responses";
      let l = await getJsonConfig(realK, env);
      l = (Array.isArray(l) ? l : []).filter(i => (i.id || i).toString() !== val);
      await setConfig(realK, JSON.stringify(l), env);
      return render(`列表: ${key}`, await getListKB(key, env));
    }

    if (type === "edit" || type === "add") {
      await setConfig(`admin_state:${cid}`, JSON.stringify({ action: "input", key: key + (type === "add" ? "_add" : "") }), env);

      let promptText = `请输入 ${key} 的值 (/cancel 取消):`;
      if (key === "ar" && type === "add") promptText = `请输入自动回复规则，格式：\n<b>关键词===回复内容</b>\n\n例如：价格===请联系人工客服\n(/cancel 取消)`;
      if (key === "welcome_msg") promptText = `请发送新的欢迎语 (/cancel 取消):\n\n• 支持 <b>文字</b> 或 <b>图片/视频/GIF</b>\n• 支持占位符: {name}\n• 直接发送媒体即可`;
      return api(env.BOT_TOKEN, "editMessageText", { chat_id: cid, message_id: mid, text: promptText, parse_mode: "HTML" });
    }

    if (type === "rotate_mode") {
      const currentMode = await getConfig("captcha_mode", env);
      const isEnabled = await getBoolConfig("enable_verify", env);
      let nextMode = "turnstile";
      let nextEnable = "true";
      let toast = "已切换: Cloudflare";
      
      if (isEnabled) {
        if (currentMode === "turnstile") {
          nextMode = "recaptcha";
          toast = "已切换: Google";
        } else {
          nextEnable = "false";
          nextMode = currentMode;
toast = "验证已关闭";
      }
      
      await setConfig("captcha_mode", nextMode, env);
      await setConfig("enable_verify", nextEnable, env);
      return render(`基础配置已更新\n${toast}`, { inline_keyboard: [[back]] });
    }
  } catch (e) {
    console.error("handleAdminConfig error:", e);
  }
}

/**
 * 处理管理员输入
 * @param {string} id - 管理员 ID
 * @param {Object} msg - 消息对象
 * @param {Object} state - 状态对象
 * @param {Object} env - 环境变量
 */
export async function handleAdminInput(id, msg, state, env) {
  const txt = msg.text || "";
  if (txt === "/cancel") {
    await sql(env, "DELETE FROM config WHERE key=?", `admin_state:${id}`);
    return handleAdminConfig(id, null, "menu", null, null, env);
  }

  let k = state.key;
  let val = txt;
  
  try {
    if (k === "welcome_msg") {
      if (msg.photo || msg.video || msg.animation) {
        let fileId, type;
        if (msg.photo) {
          type = "photo";
          fileId = msg.photo[msg.photo.length - 1].file_id;
        } else if (msg.video) {
          type = "video";
          fileId = msg.video.file_id;
        } else if (msg.animation) {
          type = "animation";
          fileId = msg.animation.file_id;
        }
        val = JSON.stringify({ type: type, file_id: fileId, caption: msg.caption || "" });
      } else {
        val = txt;
      }
    } else if (k.endsWith("_add")) {
      k = k.replace("_add", "");
      const realK = k === "ar" ? "keyword_responses" : k === "kw" ? "block_keywords" : "authorized_admins";
      const list = await getJsonConfig(realK, env);
      const arr = Array.isArray(list) ? list : [];
      if (k === "ar") {
        const [kk, rr] = txt.split("===");
        if (kk && rr) arr.push({ keywords: kk, response: rr, id: Date.now() });
        else return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 格式错误，请使用：关键词===回复内容" });
      } else arr.push(txt);
      val = JSON.stringify(arr);
      k = realK;
    } else if (k === "authorized_admins") {
      val = JSON.stringify(txt.split(/[,，]/).map(s => s.trim()).filter(Boolean));
    }

    await setConfig(k, val, env);
    await sql(env, "DELETE FROM config WHERE key=?", `admin_state:${id}`);
    const displayVal = val.startsWith("{") && k === "welcome_msg" ? "[媒体配置]" : val.substring(0, 100);
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `✅ ${k} 已更新:\n${displayVal}` }).catch(() => {});
    await handleAdminConfig(id, null, "menu", null, null, env);
  } catch (e) {
    api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `❌ 失败: ${e.message}` }).catch(() => {});
  }
}

/**
 * 获取过滤设置键盘
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>}
 */
async function getFilterKB(env) {
  const s = async k => ((await getBoolConfig(k, env)) ? "✅" : "❌");
  const b = (t, k, v) => ({ text: `${t} ${v}`, callback_data: `config:toggle:${k}:${v === "❌"}` });

  const keys = [
    "enable_forward_forwarding",
    "enable_image_forwarding",
    "enable_audio_forwarding",
    "enable_sticker_forwarding",
    "enable_link_forwarding",
    "enable_channel_forwarding",
    "enable_text_forwarding"
  ];
  const vals = await Promise.all(keys.map(k => s(k)));

  return {
    inline_keyboard: [
      [b("转发", keys[0], vals[0])],
      [b("媒体", keys[1], vals[1]), b("语音", keys[2], vals[2])],
      [b("贴纸", keys[3], vals[3]), b("链接", keys[4], vals[4])],
      [b("频道", keys[5], vals[5]), b("文本", keys[6], vals[6])],
      [{ text: "🔙 返回", callback_data: "config:menu" }]
    ]
  };
}

/**
 * 获取列表键盘
 * @param {string} type - 列表类型
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>}
 */
async function getListKB(type, env) {
  const k = type === "ar" ? "keyword_responses" : type === "kw" ? "block_keywords" : "authorized_admins";
  const l = await getJsonConfig(k, env);
  const btns = (Array.isArray(l) ? l : []).map(i => [{ text: `🗑 ${type === "ar" ? i.keywords : i}`, callback_data: `config:del:${type}:${i.id || i}` }]);
  btns.push([{ text: "➕ 添加", callback_data: `config:add:${type}` }], [{ text: "🔙 返回", callback_data: "config:menu" }]);
  return { inline_keyboard: btns };
}
