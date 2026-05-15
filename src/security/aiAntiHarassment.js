import { getBoolConfig, getConfig } from '../database/config.js';
import { getUserTrust, incrementCleanCount, recordSpam, checkAndPromoteToWhitelist } from '../database/trust.js';
import { updateUser } from '../database/users.js';
import { manageBlacklist } from '../services/blacklist.js';
import { api } from '../api/telegram.js';
import { SPAM_SYSTEM_PROMPT, SPAM_USER_PROMPT_TEMPLATE, fillPromptTemplate } from './aiSpamPrompt.js';

const SPAM_INTERCEPT_MSG = "您的消息因包含垃圾信息已被过滤。如有疑问，请联系管理员。";

export async function checkAiSpam(msg, user, env) {
  const enabled = await getBoolConfig("enable_ai_anti_harassment", env);
  if (!enabled) return { spam: false, skipped: true };

  const text = msg.text || msg.caption || "";
  if (!text) return { spam: false, skipped: true, reason: "非文本消息跳过AI检测" };

  let trustInfo = await getUserTrust(user.user_id, env);
  if (!trustInfo) {
    await import('../database/trust.js').then(m => m.createUserTrust(user.user_id, msg.from?.username, env));
    trustInfo = await getUserTrust(user.user_id, env);
  }

  if (trustInfo?.trust_status === 'trusted') {
    return { spam: false, skipped: true, reason: "AI信任用户跳过检测" };
  }

  const senderName = `${msg.from?.first_name || ''}${msg.from?.last_name ? ' ' + msg.from.last_name : ''}`.trim() || 'Unknown';
  const truncatedText = text.substring(0, 512);
  const userPrompt = fillPromptTemplate(SPAM_USER_PROMPT_TEMPLATE, { senderName, messageText: truncatedText });

  try {
    const judgment = await callLlmApi(env, SPAM_SYSTEM_PROMPT, userPrompt);
    if (judgment.startsWith('SPAM')) {
      const reason = judgment.replace(/^SPAM:\s*/, '').trim() || 'AI检测为垃圾信息';
      return { spam: true, reason, skipped: false };
    }
    return { spam: false, skipped: false };
  } catch (error) {
    console.error('[AiAntiHarassment] LLM API call failed:', error);
    return { spam: false, skipped: false, error: true };
  }
}

export async function callLlmApi(env, systemPrompt, userPrompt) {
  const baseUrl = env.LLM_API || 'https://api.openai.com/v1';
  const timeout = parseInt(env.LLM_TIMEOUT_MS) || 5000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.LLM_KEY}`
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`LLM API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM API returned empty response');
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function handleAiSpamIntercept(userId, userInfo, reason, env) {
  console.log(`[AiAntiHarassment] User ${userId} AI spam intercepted. Reason: ${reason}`);
  try {
    await recordSpam(userId, env);
    await updateUser(userId, { is_blocked: true, user_info: { ai_spam_reason: reason } }, env);
    const u = await import('../database/users.js').then(m => m.getUser(userId, env));
    await manageBlacklist(env, u, userInfo, true);

    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: SPAM_INTERCEPT_MSG
    }).catch(() => {});

    if (env.ADMIN_GROUP_ID) {
      const now = new Date();
      const utcPlus8Ms = now.getTime() + 8 * 60 * 60 * 1000;
      const d = new Date(utcPlus8Ms);
      const timeStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
      const senderName = `${userInfo?.first_name || ''}${userInfo?.last_name ? ' ' + userInfo.last_name : ''}`.trim() || 'Unknown';
      const uname = userInfo?.username ? ` (@${userInfo.username})` : '';
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        text: `🚨 AI 垃圾信息警告\n\n发送者: ${senderName}${uname} (ID: ${userId})\nAI 判定: SPAM:${reason}\n时间: ${timeStr}`,
        parse_mode: "HTML"
      }).catch(() => {});
    }
  } catch (error) {
    console.error(`[AiAntiHarassment] AI spam intercept failed for ${userId}:`, error);
  }
}

export async function handleAiCleanPass(userId, env) {
  try {
    await incrementCleanCount(userId, env);
    const promoted = await checkAndPromoteToWhitelist(userId, env);
    if (promoted) {
      console.log(`[AiAntiHarassment] User ${userId} promoted to AI trust list`);
    }
    return promoted;
  } catch (error) {
    console.error(`[AiAntiHarassment] Clean pass processing failed for ${userId}:`, error);
    return false;
  }
}