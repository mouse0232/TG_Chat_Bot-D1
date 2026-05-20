/**
 * 数据库层
 * 提供 D1 数据库连接、SQL 执行和表初始化
 */

import { log, logError, sqlOp, sqlTable } from '../utils/logger.js';

export async function sql(env, query, args = [], type = "run") {
  try {
    const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
    return type === "run" ? await stmt.run() : await stmt[type]();
  } catch (e) {
    logError('DB', 'SQL failed', e, { op: sqlOp(query), table: sqlTable(query) });
    if (query.match(/^(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE)/i)) throw e;
    return null;
  }
}

export async function tryRun(env, query, args = []) {
  try {
    const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
    return await stmt.run();
  } catch (e) {
    log.warn('DB', 'tryRun failed', { op: sqlOp(query), table: sqlTable(query), error: e.message });
    return null;
  }
}

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
    )`),

    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS ai_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      user_msg TEXT NOT NULL,
      original_judgment TEXT NOT NULL,
      correct_result TEXT NOT NULL,
      reason TEXT,
      is_summarized INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),

    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS ai_rules (
      id INTEGER PRIMARY KEY DEFAULT 1,
      content TEXT NOT NULL DEFAULT '',
      updated_at INTEGER DEFAULT 0
    )`),
    env.TG_BOT_DB.prepare(`INSERT OR IGNORE INTO ai_rules (id, content, updated_at) VALUES (1, '', 0)`)
  ]);

  await ensureUserColumns(env);
}

async function ensureUserColumns(env) {
  const info = await sql(env, "PRAGMA table_info(users)", [], "all");
  const cols = new Set((info?.results || []).map(r => r.name));

  const alters = [];
  if (!cols.has("topic_creating")) alters.push(`ALTER TABLE users ADD COLUMN topic_creating INTEGER DEFAULT 0`);
  if (!cols.has("topic_create_ts")) alters.push(`ALTER TABLE users ADD COLUMN topic_create_ts INTEGER DEFAULT 0`);

  for (const q of alters) {
    try {
      await sql(env, q);
    } catch (e) {
      log.info('DB', 'Column migration skipped', { column: q.match(/ADD COLUMN (\w+)/)?.[1], error: e.message });
    }
  }
}