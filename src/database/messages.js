/**
 * 消息数据库操作
 */

import { sql } from './index.js';
import { log, logError } from '../utils/logger.js';

export async function saveMessage(userId, messageId, text, date, env) {
  try {
    await sql(env, "INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?,?,?,?)", [
      userId,
      messageId,
      text,
      date
    ]);
  } catch (e) {
    logError('DB', 'Save message failed', e, { userId });
  }
}

export async function cleanupMessages(cutoffSec, env) {
  try {
    await sql(env, "DELETE FROM messages WHERE date < ?", cutoffSec);
  } catch (e) {
    logError('DB', 'Cleanup messages failed', e);
  }
}