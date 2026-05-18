import { getBoolConfig, getConfig } from '../database/config.js';
import { getUserTrust, incrementCleanCount, recordSpam, checkAndPromoteToWhitelist } from '../database/trust.js';
import { updateUser } from '../database/users.js';
import { manageBlacklist } from '../services/blacklist.js';
import { api } from '../api/telegram.js';
import { callGreenApi } from './aliyunGreen.js';
import { log, logError } from '../utils/logger.js';

const SPAM_INTERCEPT_MSG = "您的消息因包含垃圾信息已被过滤。如有疑问，请联系管理员。";

const GREEN_LABEL_MAP = {
  nonLabel: "未检出风险",
  pornographic_adult: "色情内容",
  sexual_terms: "性健康内容",
  sexual_suggestive: "低俗内容",
  sexual_orientation: "性取向内容",
  regional_cn: "国内涉政内容",
  regional_illegal: "非法政治内容",
  regional_controversial: "政治争议",
  regional_racism: "种族主义",
  violent_extremist: "极端组织",
  violent_incidents: "极端主义内容",
  violent_weapons: "武器弹药",
  violence_unscList: "联合国制裁名单",
  contraband_drug: "毒品相关",
  contraband_gambling: "赌博相关",
  inappropriate_ethics: "不良价值观",
  inappropriate_profanity: "攻击辱骂",
  inappropriate_oral: "低俗口头语",
  inappropriate_religion: "宗教亵渎",
  pt_to_contact: "引流广告号",
  pt_to_sites: "站外引流",
  customized: "自定义违规"
};

function formatTimeStr() {
  const now = new Date();
  const utcPlus8Ms = now.getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(utcPlus8Ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

function formatSenderName(userInfo) {
  return `${userInfo?.first_name || ''}${userInfo?.last_name ? ' ' + userInfo.last_name : ''}`.trim() || 'Unknown';
}

export async function checkGreenSpam(msg, user, env) {
  const enabled = await getBoolConfig("enable_aliyun_green", env);
  if (!enabled) return { spam: false, skipped: true };

  const text = msg.text || msg.caption || "";
  if (!text) return { spam: false, skipped: true, reason: "非文本消息跳过Green检测" };

  let trustInfo = await getUserTrust(user.user_id, env);
  if (!trustInfo) {
    await import('../database/trust.js').then(m => m.createUserTrust(user.user_id, msg.from?.username, env));
    trustInfo = await getUserTrust(user.user_id, env);
  }

  if (trustInfo?.trust_status === 'trusted') {
    return { spam: false, skipped: true, reason: "信任用户跳过检测" };
  }

  const truncatedText = text.substring(0, 2000);

  try {
    const greenResult = await callGreenApi(env, truncatedText);
    const data = greenResult.Data;
    const riskLevel = data?.RiskLevel || "none";
    const results = data?.Result || [];

    if (riskLevel === "high") {
      const topResult = [...results].sort((a, b) => (b.Confidence || 0) - (a.Confidence || 0))[0];
      const reason = GREEN_LABEL_MAP[topResult?.Label] || topResult?.Description || "Green检测为高风险内容";
      return { spam: true, reason, labels: results, riskLevel, skipped: false };
    }

    if (riskLevel === "medium") {
      const mediumThreshold = parseFloat(await getConfig("aliyun_green_medium_block_threshold", env)) || 80;
      const maxConfidence = results.length > 0 ? Math.max(...results.map(r => r.Confidence || 0)) : 0;
      if (maxConfidence >= mediumThreshold) {
        const topResult = [...results].sort((a, b) => (b.Confidence || 0) - (a.Confidence || 0))[0];
        const reason = GREEN_LABEL_MAP[topResult?.Label] || topResult?.Description || "Green检测为中高风险内容";
        return { spam: true, reason, labels: results, riskLevel, skipped: false };
      }
    }

    return { spam: false, labels: results, riskLevel, skipped: false };
  } catch (error) {
    logError('GreenAntiHarass', 'Green API call failed', error);
    return { spam: false, skipped: false, error: true };
  }
}

export async function handleGreenSpamIntercept(userId, userInfo, reason, riskLevel, labels, env) {
  log.info('GreenAntiHarass', 'User intercepted', { userId, reason, riskLevel });
  try {
    await recordSpam(userId, env);
    const labelSummary = labels?.map(l => `${GREEN_LABEL_MAP[l.Label] || l.Label}(${l.Confidence}分)`).join(', ') || reason;
    await updateUser(userId, { is_blocked: true, user_info: { green_spam_reason: reason, green_risk_level: riskLevel, green_labels: labelSummary } }, env);
    const u = await import('../database/users.js').then(m => m.getUser(userId, env));
    await manageBlacklist(env, u, userInfo, true);

    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: SPAM_INTERCEPT_MSG
    }).catch(e => log.debug('GreenAntiHarass', 'Notification skipped', { userId, error: e?.message }));

    if (env.ADMIN_GROUP_ID) {
      const timeStr = formatTimeStr();
      const senderName = formatSenderName(userInfo);
      const uname = userInfo?.username ? ` (@${userInfo.username})` : '';
      const labelDetail = labels?.map(l => `${GREEN_LABEL_MAP[l.Label] || l.Label}: ${l.Confidence}分`).join('\n') || reason;
      await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        text: `[Green] 垃圾信息警告\n\n发送者: ${senderName}${uname} (ID: ${userId})\n风险等级: ${riskLevel}\n${labelDetail}\n时间: ${timeStr}`,
        parse_mode: "HTML"
      }).catch(e => log.debug('GreenAntiHarass', 'Admin notification skipped', { userId, error: e?.message }));
    }
  } catch (error) {
    logError('GreenAntiHarass', 'Intercept failed', error, { userId });
  }
}

export async function handleGreenCleanPass(userId, env) {
  try {
    await incrementCleanCount(userId, env);
    const threshold = parseInt(await getConfig("aliyun_green_trust_threshold", env)) || 3;
    const promoted = await checkAndPromoteToWhitelist(userId, env, threshold);
    if (promoted) {
      log.info('GreenAntiHarass', 'User promoted to trust', { userId });
    }
    return promoted;
  } catch (error) {
    logError('GreenAntiHarass', 'Clean pass failed', error, { userId });
    return false;
  }
}