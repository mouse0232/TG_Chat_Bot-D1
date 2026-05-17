/**
 * Update 幂等性数据库操作
 */

import { tryRun, sql } from './index.js';
import { log, logError } from '../utils/logger.js';

export async function markUpdateProcessed(update, env) {
  try {
    const uid = (update && (update.update_id ?? update.updateId))?.toString();
    if (!uid) return true;

    const now = Date.now();
    const res = await tryRun(env, "INSERT OR IGNORE INTO processed_updates (update_id, ts) VALUES (?,?)", [uid, now]);
    const changes = res?.meta?.changes ?? res?.changes ?? 0;
    return changes > 0;
  } catch (e) {
    log.warn('DB', 'markUpdateProcessed failed', { error: e.message });
    return true;
  }
}

export async function cleanupProcessedUpdates(cutoff, env) {
  try {
    await sql(env, "DELETE FROM processed_updates WHERE ts < ?", cutoff);
  } catch (e) {
    logError('DB', 'Cleanup updates failed', e);
  }
}