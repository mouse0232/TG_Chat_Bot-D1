/**
 * 管理面板处理器
 */

import { api } from '../api/telegram.js';
import { getConfig, setConfig, getBoolConfig, getJsonConfig } from '../database/config.js';
import { sql } from '../database/index.js';
import { escapeHTML, safeParse } from '../utils/helpers.js';

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
            [{ text: "🌙 营业状态", callback_data: "config:menu:busy" }]
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
    }

    if (type === "toggle") {
      await setConfig(key, val, env);
      return key === "busy_mode"
        ? handleAdminConfig(cid, mid, "menu", "busy", null, env)
        : key === "enable_qa_verify"
          ? handleAdminConfig(cid, mid, "menu", "base", null, env)
          : render("🛠 <b>过滤设置</b>", await getFilterKB(env));
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
