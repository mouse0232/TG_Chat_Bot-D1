/**
 * 用户数据库操作
 */

import { sql, tryRun } from './index.js';
import { safeParse } from '../utils/helpers.js';

/**
 * 获取用户信息（不存在则创建）
 * @param {string|number} id - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>}
 */
export async function getUser(id, env) {
  let u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, "first");
  if (!u) {
    try {
      await sql(env, "INSERT OR IGNORE INTO users (user_id, user_state, user_info_json) VALUES (?, 'new', ?)", [id, "{}"]);
    } catch {}
    u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, "first");
  }
  if (!u) {
    u = {
      user_id: id,
      user_state: "new",
      is_blocked: 0,
      block_count: 0,
      topic_id: null,
      user_info_json: "{}",
      topic_creating: 0,
      topic_create_ts: 0
    };
  }
  u.is_blocked = !!u.is_blocked;
  u.user_info = safeParse(u.user_info_json, {});
  u.topic_creating = !!u.topic_creating;
  u.topic_create_ts = u.topic_create_ts || 0;
  return u;
}

/**
 * 合并用户信息
 * @param {string|number} id - 用户 ID
 * @param {Object} patch - 要合并的数据
 * @param {Object} env - 环境变量
 * @returns {Promise<string>}
 */
export async function mergeUserInfo(id, patch, env) {
  const row = await sql(env, "SELECT user_info_json FROM users WHERE user_id = ?", id, "first");
  const cur = safeParse(row?.user_info_json || "{}", {});
  const merged = { ...(cur && typeof cur === "object" ? cur : {}), ...(patch && typeof patch === "object" ? patch : {}) };
  return JSON.stringify(merged);
}

/**
 * 更新用户信息
 * @param {string|number} id - 用户 ID
 * @param {Object} data - 更新数据
 * @param {Object} env - 环境变量
 */
export async function updateUser(id, data, env) {
  if (data.user_info) {
    data.user_info_json = await mergeUserInfo(id, data.user_info, env);
    delete data.user_info;
  }

  const keys = Object.keys(data);
  if (!keys.length) return;

  const safeKeys = keys.filter(k =>
    ["user_state", "is_blocked", "block_count", "topic_id", "user_info_json", "topic_creating", "topic_create_ts"].includes(k)
  );
  if (!safeKeys.length) return;

  const q = `UPDATE users SET ${safeKeys.map(k => `${k}=?`).join(",")} WHERE user_id=?`;
  const v = [...safeKeys.map(k => (typeof data[k] === "boolean" ? (data[k] ? 1 : 0) : data[k])), id];
  try {
    await sql(env, q, v);
  } catch (e) {
    console.error("Update User Failed:", e);
  }
}

/**
 * 根据话题 ID 查找用户
 * @param {string} topicId - 话题 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<Object|null>}
 */
export async function getUserByTopicId(topicId, env) {
  return await sql(env, "SELECT * FROM users WHERE topic_id = ?", topicId, "first");
}
