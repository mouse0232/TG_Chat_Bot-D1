/**
 * 话题服务
 * 负责话题创建和管理
 */

import { api } from '../api/telegram.js';
import { updateUser, getUser } from '../database/users.js';
import { getUMeta } from '../utils/helpers.js';

/**
 * 创建用户话题
 * @param {string} uid - 用户 ID
 * @param {Object} tgUser - Telegram 用户对象
 * @param {Object} dbUser - 数据库用户对象
 * @param {Object} env - 环境变量
 * @returns {Promise<string>} - 话题 ID
 */
export async function createTopic(uid, tgUser, dbUser, env) {
  const meta = getUMeta(tgUser, dbUser, Date.now() / 1000);
  const t = await api(env.BOT_TOKEN, "createForumTopic", { 
    chat_id: env.ADMIN_GROUP_ID, 
    name: meta.topicName 
  });
  const tid = t.message_thread_id.toString();
  
  await updateUser(uid, { topic_id: tid }, env);
  return tid;
}

/**
 * 获取或创建用户话题
 * @param {string} uid - 用户 ID
 * @param {Object} tgUser - Telegram 用户对象
 * @param {Object} dbUser - 数据库用户对象
 * @param {Object} env - 环境变量
 * @returns {Promise<string|null>}
 */
export async function getOrCreateTopic(uid, tgUser, dbUser, env) {
  if (dbUser.topic_id) return dbUser.topic_id;
  return await createTopic(uid, tgUser, dbUser, env);
}
