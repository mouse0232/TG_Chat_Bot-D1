import { getConfig } from './config.js';

function getTodayDateStr() {
  const now = new Date();
  const utcPlus8Ms = now.getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(utcPlus8Ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function getUserTrust(userId, env) {
  const db = env.TG_BOT_DB;
  return db.prepare('SELECT * FROM user_trust WHERE user_id = ?').bind(userId).first();
}

export async function createUserTrust(userId, username, env) {
  const db = env.TG_BOT_DB;
  const now = Date.now();
  const today = getTodayDateStr();
  await db.prepare(
    'INSERT OR IGNORE INTO user_trust (user_id, username, trust_status, consecutive_clean_count, last_clean_date, total_spam_count, last_message_at, created_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?)'
  ).bind(userId, username || null, 'new', today, now, now).run();
}

export async function incrementCleanCount(userId, env) {
  const db = env.TG_BOT_DB;
  const today = getTodayDateStr();
  const trust = await getUserTrust(userId, env);

  if (trust && trust.last_clean_date !== today) {
    await db.prepare(
      'UPDATE user_trust SET consecutive_clean_count = 1, trust_status = ?, last_clean_date = ?, last_message_at = ? WHERE user_id = ?'
    ).bind('new', today, Date.now(), userId).run();
    return;
  }

  await db.prepare(
    'UPDATE user_trust SET consecutive_clean_count = consecutive_clean_count + 1, last_message_at = ? WHERE user_id = ?'
  ).bind(Date.now(), userId).run();
}

export async function recordSpam(userId, env) {
  const db = env.TG_BOT_DB;
  const today = getTodayDateStr();
  await db.prepare(
    'UPDATE user_trust SET consecutive_clean_count = 0, last_clean_date = ?, total_spam_count = total_spam_count + 1, trust_status = ?, last_message_at = ? WHERE user_id = ?'
  ).bind(today, 'monitoring', Date.now(), userId).run();
}

export async function checkAndPromoteToWhitelist(userId, env, customThreshold) {
  const threshold = customThreshold || parseInt(await getConfig("ai_anti_harassment_trust_threshold", env)) || 3;
  const trust = await getUserTrust(userId, env);
  if (!trust) return false;
  if (trust.trust_status === 'trusted') return false;

  if (trust.consecutive_clean_count >= threshold) {
    const db = env.TG_BOT_DB;
    const now = Date.now();
    await db.prepare(
      'UPDATE user_trust SET trust_status = ?, whitelisted_at = ?, whitelisted_by = ? WHERE user_id = ?'
    ).bind('trusted', now, 'auto', userId).run();
    return true;
  }
  return false;
}

export async function trustUser(userId, by, env) {
  const db = env.TG_BOT_DB;
  const now = Date.now();
  const today = getTodayDateStr();
  await db.prepare(
    'INSERT OR REPLACE INTO user_trust (user_id, username, trust_status, consecutive_clean_count, last_clean_date, total_spam_count, whitelisted_at, whitelisted_by, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)'
  ).bind(userId, null, 'trusted', 0, today, now, by, now, now).run();
}

export async function untrustUser(userId, env) {
  const db = env.TG_BOT_DB;
  const today = getTodayDateStr();
  await db.prepare(
    'UPDATE user_trust SET trust_status = ?, consecutive_clean_count = 0, last_clean_date = ?, total_spam_count = total_spam_count + 1, whitelisted_at = NULL, whitelisted_by = NULL WHERE user_id = ?'
  ).bind('monitoring', today, userId).run();
}