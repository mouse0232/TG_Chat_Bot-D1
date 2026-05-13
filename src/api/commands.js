/**
 * Bot 命令管理
 */

import { api } from './telegram.js';
import { getJsonConfig } from '../database/config.js';

/**
 * 注册 Bot 命令
 * @param {Object} env - 环境变量
 */
export async function registerCommands(env) {
  try {
    await api(env.BOT_TOKEN, "deleteMyCommands", { scope: { type: "default" } });
    await api(env.BOT_TOKEN, "setMyCommands", { 
      commands: [{ command: "start", description: "开始 / Start" }], 
      scope: { type: "default" } 
    });

    const admins = [...(env.ADMIN_IDS || "").split(/[,，]/), ...(await getJsonConfig("authorized_admins", env))];
    const uniqueAdmins = [...new Set(admins.map(i => i.toString().trim()).filter(Boolean))];

    for (const id of uniqueAdmins) {
      await api(env.BOT_TOKEN, "setMyCommands", {
        commands: [
          { command: "start", description: "面板" }, 
          { command: "help", description: "帮助" }, 
          { command: "reset", description: "重置用户验证(主管理员)" }
        ],
        scope: { type: "chat", chat_id: id }
      });
    }
  } catch {}
}
