/**
 * 配置数据库操作
 */

import { sql } from './index.js';
import { CACHE } from '../utils/constants.js';

/**
 * 获取配置值（带缓存）
 * @param {string} k - 配置键
 * @param {Object} env - 环境变量
 * @returns {Promise<string>}
 */
export async function getConfig(k, env) {
  const { DEFAULTS } = await import('../utils/constants.js');
  const now = Date.now();
  
  if (CACHE.ts && now - CACHE.ts < CACHE.ttl && CACHE.data[k] !== undefined) {
    return CACHE.data[k];
  }

  const rows = await sql(env, "SELECT * FROM config", [], "all");
  if (rows?.results) {
    CACHE.data = {};
    rows.results.forEach(r => (CACHE.data[r.key] = r.value));
    CACHE.ts = now;
  }

  const envK = k.toUpperCase().replace(/_MSG|_Q|_A/, m => ({ _MSG: "_MESSAGE", _Q: "_QUESTION", _A: "_ANSWER" }[m]));
  return CACHE.data[k] ?? (env[envK] || DEFAULTS[k] || "");
}

/**
 * 设置配置值
 * @param {string} k - 配置键
 * @param {string} v - 配置值
 * @param {Object} env - 环境变量
 */
export async function setConfig(k, v, env) {
  await sql(env, "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [k, v]);
  CACHE.ts = 0;
}

/**
 * 获取布尔配置
 * @param {string} k - 配置键
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>}
 */
export async function getBoolConfig(k, env) {
  return (await getConfig(k, env)) === "true";
}

/**
 * 获取 JSON 配置
 * @param {string} k - 配置键
 * @param {Object} env - 环境变量
 * @returns {Promise<Array>}
 */
export async function getJsonConfig(k, env) {
  const { safeParse } = await import('../utils/helpers.js');
  return safeParse(await getConfig(k, env), []);
}
