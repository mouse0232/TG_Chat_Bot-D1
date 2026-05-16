/**
 * 权限检测服务
 */

import { api } from '../api/telegram.js';

/**
 * 检测 Bot 自身权限
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} 检测结果
 */
async function checkBotPermissions(env) {
  const result = {
    botTokenValid: false,
    botInfo: null,
    canSetCommands: false,
    canSendMessage: false,
    errors: []
  };

  if (!env.BOT_TOKEN) {
    result.errors.push("BOT_TOKEN 未配置");
    return result;
  }

  try {
    const botInfo = await api(env.BOT_TOKEN, "getMe", {});
    result.botTokenValid = true;
    result.botInfo = {
      id: botInfo.id,
      username: botInfo.username,
      firstName: botInfo.first_name
    };

    try {
      await api(env.BOT_TOKEN, "getMyCommands", {});
      result.canSetCommands = true;
    } catch (e) {
      result.errors.push(`命令权限受限：${e.message}`);
    }

    try {
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: botInfo.id,
        text: "Permission check"
      });
      result.canSendMessage = true;
    } catch (e) {
      result.errors.push(`消息发送权限受限：${e.message}`);
    }
  } catch (e) {
    result.errors.push(`Bot Token 无效：${e.message}`);
  }

  return result;
}

/**
 * 检测群管理权限
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} 检测结果
 */
async function checkGroupPermissions(env) {
  const result = {
    adminGroupIdConfigured: false,
    isBotAdmin: false,
    canCreateTopics: false,
    canSendMessages: false,
    canPinMessages: false,
    errors: []
  };

  if (!env.ADMIN_GROUP_ID) {
    result.errors.push("ADMIN_GROUP_ID 未配置");
    return result;
  }

  result.adminGroupIdConfigured = true;
  const chatId = env.ADMIN_GROUP_ID;

  try {
    const chat = await api(env.BOT_TOKEN, "getChat", { chat_id: chatId });
    
    try {
      const botInfo = await api(env.BOT_TOKEN, "getMe", {});
      const member = await api(env.BOT_TOKEN, "getChatMember", {
        chat_id: chatId,
        user_id: botInfo.id
      });
      
      if (member.status === "administrator" || member.status === "creator") {
        result.isBotAdmin = true;
        
        result.canCreateTopics = !!chat.is_forum || member.can_manage_topics || false;
        result.canSendMessages = member.can_send_messages || member.can_post_messages || false;
        result.canPinMessages = member.can_pin_messages || false;
      } else {
        result.errors.push("Bot 不是管理群组的管理员");
      }
    } catch (e) {
      result.errors.push(`管理员身份验证失败：${e.message}`);
    }
  } catch (e) {
    result.errors.push(`群组访问失败：${e.message}`);
  }

  return result;
}

/**
 * 综合权限检测
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} 完整检测结果
 */
export async function checkAllPermissions(env) {
  const [botResult, groupResult] = await Promise.allSettled([
    checkBotPermissions(env),
    checkGroupPermissions(env)
  ]);

  return {
    bot: botResult.status === "fulfilled" ? botResult.value : { error: botResult.reason?.message, errors: [botResult.reason?.message] },
    group: groupResult.status === "fulfilled" ? groupResult.value : { error: groupResult.reason?.message, errors: [groupResult.reason?.message] },
    timestamp: Date.now()
  };
}

/**
 * 格式化检测报告为 HTML
 * @param {Object} result - 检测结果
 * @returns {string} HTML 格式的报告
 */
export function formatPermissionReport(result) {
  const t = (v) => v ? "✅" : "❌";
  
  let html = `🔐 <b>权限检测报告</b>\n\n`;
  
  html += `<b>Bot 权限</b>\n`;
  html += `Token 有效：${t(result.bot.botTokenValid)}\n`;
  if (result.bot.botInfo) {
    html += `Bot: @${result.bot.botInfo.username}\n`;
  }
  html += `命令权限：${t(result.bot.canSetCommands)}\n`;
  html += `消息权限：${t(result.bot.canSendMessage)}\n`;
  
  html += `\n<b>群管理权限</b>\n`;
  html += `群组配置：${t(result.group.adminGroupIdConfigured)}\n`;
  html += `管理员身份：${t(result.group.isBotAdmin)}\n`;
  html += `话题权限：${t(result.group.canCreateTopics)}\n`;
  html += `消息权限：${t(result.group.canSendMessages)}\n`;
  html += `置顶权限：${t(result.group.canPinMessages)}\n`;
  
  const errors = [...(result.bot.errors || []), ...(result.group.errors || [])];
  if (errors.length > 0) {
    html += `\n<b>⚠️ 问题</b>:\n`;
    html += errors.map(e => `• ${e}`).join('\n');
    html += `\n\n请根据提示修复后重新检测`;
  } else {
    html += `\n✅ 所有权限检测通过`;
  }
  
  return html;
}
