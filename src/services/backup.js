/**
 * 备份服务
 */

import { api } from '../api/telegram.js';
import { getConfig } from '../database/config.js';
import { escapeHTML } from '../utils/helpers.js';
import { log } from '../utils/logger.js';

export async function handleBackup(msg, meta, env) {
  const bid = await getConfig("backup_group_id", env);
  if (!bid) return;

  try {
    await api(env.BOT_TOKEN, "copyMessage", {
      chat_id: bid,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  } catch {
    log.info('Backup', 'Backup fallback to text', { chatId: msg.chat.id });
    if (msg.text) {
      api(env.BOT_TOKEN, "sendMessage", {
        chat_id: bid,
        text: `<b>备份</b> ${escapeHTML(meta.name)}:\n${escapeHTML(msg.text)}`,
        parse_mode: "HTML"
      }).catch(e => log.debug('Backup', 'Backup text send failed', { chatId: msg.chat.id, error: e?.message || String(e) }));
    }
  }
}