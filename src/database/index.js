/**
 * 数据库层
 * 提供 D1 数据库连接、SQL 执行和表初始化
 */

/**
 * 执行 SQL 查询
 * @param {Object} env - 环境变量
 * @param {string} query - SQL 语句
 * @param {Array} args - 参数
 * @param {string} type - 查询类型 (run/first/all)
 * @returns {Promise<*>}
 */
export async function sql(env, query, args = [], type = "run") {
  try {
    const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
    return type === "run" ? await stmt.run() : await stmt[type]();
  } catch (e) {
    console.error(`SQL Fail [${query}]:`, e);
    if (query.match(/^(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE)/i)) throw e;
    return null;
  }
}

/**
 * 尝试执行 SQL（失败不抛异常）
 * @param {Object} env - 环境变量
 * @param {string} query - SQL 语句
 * @param {Array} args - 参数
 * @returns {Promise<*>}
 */
export async function tryRun(env, query, args = []) {
  try {
    const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
    return await stmt.run();
  } catch {
    return null;
  }
}

/**
 * 初始化数据库表结构
 * @param {Object} env - 环境变量
 */
export async function dbInit(env) {
  if (!env.TG_BOT_DB) return;

  await env.TG_BOT_DB.batch([
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`),
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      user_state TEXT DEFAULT 'new',
      is_blocked INTEGER DEFAULT 0,
      block_count INTEGER DEFAULT 0,
      topic_id TEXT,
      user_info_json TEXT DEFAULT '{}',
      topic_creating INTEGER DEFAULT 0,
      topic_create_ts INTEGER DEFAULT 0
    )`),
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
      user_id TEXT,
      message_id TEXT,
      text TEXT,
      date INTEGER,
      PRIMARY KEY (user_id, message_id)
    )`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date)`),

    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS processed_updates (
      update_id TEXT PRIMARY KEY,
      ts INTEGER
    )`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_processed_updates_ts ON processed_updates(ts)`),

    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS ratelimits (
      key TEXT PRIMARY KEY,
      ts INTEGER,
      count INTEGER
    )`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ratelimits_ts ON ratelimits(ts)`),

    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS user_trust (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      trust_status TEXT DEFAULT 'new',
      consecutive_clean_count INTEGER DEFAULT 0,
      last_clean_date TEXT,
      total_spam_count INTEGER DEFAULT 0,
      whitelisted_at INTEGER,
      whitelisted_by TEXT,
      last_message_at INTEGER,
      created_at INTEGER
    )`)
  ]);

  await ensureUserColumns(env);
}

/**
 * 确保 users 表包含所有必要列
 * @param {Object} env - 环境变量
 */
async function ensureUserColumns(env) {
  const info = await sql(env, "PRAGMA table_info(users)", [], "all");
  const cols = new Set((info?.results || []).map(r => r.name));

  const alters = [];
  if (!cols.has("topic_creating")) alters.push(`ALTER TABLE users ADD COLUMN topic_creating INTEGER DEFAULT 0`);
  if (!cols.has("topic_create_ts")) alters.push(`ALTER TABLE users ADD COLUMN topic_create_ts INTEGER DEFAULT 0`);

  for (const q of alters) {
    try {
      await sql(env, q);
    } catch {}
  }
}
