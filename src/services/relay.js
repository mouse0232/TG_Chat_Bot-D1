/**
 * 消息转发服务
 * 负责将用户消息转发到管理员群组话题
 */

import { api } from '../api/telegram.js';
import { updateUser, getUser } from '../database/users.js';
import { saveMessage } from '../database/messages.js';
import { DELIVERED_REACTION, TOPIC_LOCK_STALE_MS, TOPIC_LOCK_POLL_MAX, TOPIC_LOCK_POLL_BASE_MS } from '../utils/constants.js';
import { sleep, getUMeta } from '../utils/helpers.js';
import { hasLock, setLock } from '../utils/cache.js';
import { sendInfoCardToTopic } from './infoCard.js';
import { handleInbox } from './inbox.js';
import { handleBackup } from './backup.js';
import { maybeCleanupMessages } from '../security/cleanup.js';
import { log, logError } from '../utils/logger.js';

export async function relayToTopic(msg, u, env, ctx) {
  const uid = u.user_id;
  log.info('Relay', 'Message relay started', { userId: uid, requestId: ctx?.requestId });

  if (u.is_blocked) {
    const { isAuthAdmin } = await import('../utils/cache.js');
    if (!(await isAuthAdmin(uid, env))) return;
  }

  const uMeta = getUMeta(msg.from, u, msg.date);
  let tid = u.topic_id;

  if (!tid) {
    tid = await createTopicWithLock(uid, u, uMeta, env, ctx);
    if (!tid) return;
  }

  let relaySuccess = false;
  try {
    await api(env.BOT_TOKEN, "forwardMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      from_chat_id: uid,
      message_id: msg.message_id,
      message_thread_id: tid
    });
    relaySuccess = true;
  } catch {
    try {
      const extra = {};
      if (msg.text) extra.text = msg.text;
      if (msg.caption) extra.caption = msg.caption;
      await api(env.BOT_TOKEN, "copyMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        from_chat_id: uid,
        message_id: msg.message_id,
        message_thread_id: tid,
        ...extra
      });
      relaySuccess = true;
    } catch (cpErr) {
      logError('Relay', 'Copy message failed', cpErr, { userId: uid });
      if (cpErr.message && (cpErr.message.includes("thread") || cpErr.message.includes("not found"))) {
        await updateUser(uid, { topic_id: null }, env);
        return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "⚠️ 会话已过期，请重发" });
      }
    }
  }

  if (relaySuccess) {
    log.info('Relay', 'Message forwarded to topic', { userId: uid, topicId: tid, requestId: ctx?.requestId });

    const dk = `delivered:${uid}:${msg.message_id}`;
    if (!hasLock(dk)) {
      setLock(dk, 20000);
      markDelivered(env, uid, msg.message_id);
    }

    if (msg.text) {
      try {
        await saveMessage(uid, msg.message_id, msg.text, msg.date, env);
      } catch (e) {
        log.warn('Relay', 'Save message skipped', { userId: uid, error: e.message });
      }
      maybeCleanupMessages(env, ctx);
    }

    await Promise.all([
      handleInbox(env, msg, u, tid, uMeta),
      handleBackup(msg, uMeta, env)
    ]);
  }
}

async function createTopicWithLock(uid, u, uMeta, env, ctx) {
  const now = Date.now();
  const staleBefore = now - TOPIC_LOCK_STALE_MS;

  const { tryRun } = await import('../database/index.js');
  const lockRes = await tryRun(
    env,
    `UPDATE users
     SET topic_creating=1, topic_create_ts=?
     WHERE user_id=?
       AND (topic_id IS NULL OR topic_id='')
       AND (topic_creating=0 OR topic_create_ts < ?)`,
    [now, uid, staleBefore]
  );

  const locked = (lockRes?.meta?.changes ?? lockRes?.changes ?? 0) === 1;

  if (locked) {
    try {
      const fresh = await getUser(uid, env);
      if (fresh.topic_id) {
        return fresh.topic_id;
      } else {
        const t = await api(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: uMeta.topicName });
        const tid = t.message_thread_id.toString();

        await updateUser(uid, { topic_id: tid, topic_creating: 0, topic_create_ts: 0 }, env);
        u.topic_id = tid;

        await sendInfoCardToTopic(env, u, { id: uid, first_name: uMeta.name }, tid);
        return tid;
      }
    } catch (e) {
      logError('Relay', 'Topic create failed', e, { userId: uid, requestId: ctx?.requestId });
      await updateUser(uid, { topic_creating: 0 }, env);
      const existUser = await getUser(uid, env);
      if (existUser.topic_id) return existUser.topic_id;

      api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "⚠️ 系统繁忙，请稍后重试" }).catch(e => log.debug('Relay', 'System busy notification failed', { userId: uid, error: e?.message || String(e) }));
      return null;
    }
  } else {
    for (let i = 0; i < TOPIC_LOCK_POLL_MAX; i++) {
      const delay = Math.min(1500, TOPIC_LOCK_POLL_BASE_MS * Math.pow(2, i)) + Math.floor(Math.random() * 60);
      await sleep(delay);

      const fresh = await getUser(uid, env);
      if (fresh.topic_id) {
        u.topic_id = fresh.topic_id;
        return fresh.topic_id;
      }
    }

    api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "⚠️ 系统繁忙，请稍后重试" }).catch(e => log.debug('Relay', 'System busy notification failed', { userId: uid, error: e?.message || String(e) }));
    return null;
  }
}

async function markDelivered(env, chatId, messageId) {
  try {
    await api(env.BOT_TOKEN, "setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji: DELIVERED_REACTION }],
      is_big: false
    });
  } catch (e) {
    log.debug('Relay', 'Set delivered reaction failed', { chatId, messageId, error: e?.message || String(e) });
  }
}