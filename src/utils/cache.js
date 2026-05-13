/**
 * 缓存管理
 * 提供内存缓存的获取、设置和失效功能
 */

import { CACHE } from './constants.js';

/**
 * 获取配置值（带缓存）
 * @param {string} k - 配置键
 * @param {Object} env - 环境变量
 * @returns {Promise<string>}
 */
export async function getCfg(k, env) {
  const now = Date.now();
  if (CACHE.ts && now - CACHE.ts < CACHE.ttl && CACHE.data[k] !== undefined) {
    return CACHE.data[k];
  }

  const { sql } = await import('../database/index.js');
  const rows = await sql(env, "SELECT * FROM config", [], "all");
  if (rows?.results) {
    CACHE.data = {};
    rows.results.forEach(r => (CACHE.data[r.key] = r.value));
    CACHE.ts = now;
  }

  const envK = k.toUpperCase().replace(/_MSG|_Q|_A/, m => ({ _MSG: "_MESSAGE", _Q: "_QUESTION", _A: "_ANSWER" }[m]));
  return CACHE.data[k] ?? (env[envK] || '');
}

/**
 * 设置配置值
 * @param {string} k - 配置键
 * @param {string} v - 配置值
 * @param {Object} env - 环境变量
 */
export async function setCfg(k, v, env) {
  const { sql } = await import('../database/index.js');
  await sql(env, "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [k, v]);
  CACHE.ts = 0;
}

/**
 * 获取布尔配置
 * @param {string} k - 配置键
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>}
 */
export async function getBool(k, env) {
  return (await getCfg(k, env)) === "true";
}

/**
 * 获取 JSON 配置
 * @param {string} k - 配置键
 * @param {Object} env - 环境变量
 * @returns {Promise<Array>}
 */
export async function getJsonCfg(k, env) {
  const { safeParse } = await import('./helpers.js');
  return safeParse(await getCfg(k, env), []);
}

/**
 * 获取管理员集合
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>}
 */
export async function getAdminSets(env) {
  const now = Date.now();
  if (CACHE.admin.ts && now - CACHE.admin.ts < CACHE.admin.ttl && CACHE.admin.primarySet.size) {
    return { primary: CACHE.admin.primarySet, auth: CACHE.admin.authSet };
  }

  const { parseIdsToSet } = await import('./helpers.js');
  const primary = parseIdsToSet(env.ADMIN_IDS || "");
  const authList = await getJsonCfg("authorized_admins", env);
  const auth = new Set([...primary, ...((Array.isArray(authList) ? authList : []).map(x => x.toString()))]);

  CACHE.admin.ts = now;
  CACHE.admin.primarySet = primary;
  CACHE.admin.authSet = auth;

  return { primary, auth };
}

/**
 * 检查是否为主管理员
 * @param {string|number} id - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>}
 */
export async function isPrimaryAdmin(id, env) {
  const sets = await getAdminSets(env);
  return sets.primary.has(id.toString());
}

/**
 * 检查是否为授权管理员
 * @param {string|number} id - 用户 ID
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>}
 */
export async function isAuthAdmin(id, env) {
  const sets = await getAdminSets(env);
  return sets.auth.has(id.toString());
}

/**
 * 检查缓存锁
 * @param {string} key - 锁键
 * @returns {boolean}
 */
export function hasLock(key) {
  return CACHE.locks.has(key);
}

/**
 * 设置缓存锁（自动过期）
 * @param {string} key - 锁键
 * @param {number} ttlMs - 过期时间（毫秒）
 */
export function setLock(key, ttlMs) {
  CACHE.locks.add(key);
  setTimeout(() => CACHE.locks.delete(key), ttlMs);
}

/**
 * 清理调度节流检查
 * @param {string} key - 清理键
 * @param {number} minIntervalMs - 最小间隔
 * @returns {boolean}
 */
export function shouldCleanup(key, minIntervalMs) {
  const now = Date.now();
  const last = CACHE.cleanup[key] || 0;
  if (now - last < minIntervalMs) return false;
  CACHE.cleanup[key] = now;
  return true;
}
