import { logError } from '../utils/logger.js';

const GLOBAL_SPAM_USER_ID = "global_spam_patterns";
const BASE_URL = "https://api.302.ai";

export class MemobaseService {
  constructor(env) {
    this.apiKey = env.MEMOBASE_API_KEY;
    this.enabled = env.ENABLE_MEMOBASE === 'true';
    this.timeout = parseInt(env.MEMOBASE_TIMEOUT_MS) || 3000;
  }

  async isAvailable() {
    if (!this.enabled || !this.apiKey) return false;
    try {
      await this.apiCall('/memobase/api/v1/users', 'GET');
      return true;
    } catch {
      return false;
    }
  }

  async getGlobalContext() {
    if (!this.enabled) return '';
    try {
      const res = await this.apiCall(`/memobase/api/v1/users/context/${GLOBAL_SPAM_USER_ID}`, 'GET');
      return res?.data?.profiles?.map(p => p.content).join('\n') || '';
    } catch (e) {
      logError('Memobase', 'getGlobalContext failed', e);
      return '';
    }
  }

  async insertGlobalCorrection(originalMsg, correctResult, reason = '管理员纠正') {
    if (!this.enabled) return;
    const messages = [
      { role: 'user', content: originalMsg },
      { role: 'assistant', content: `[管理员确认] 正确判定: ${correctResult}. 理由: ${reason}` }
    ];
    await this._insertBlob(GLOBAL_SPAM_USER_ID, messages).catch(() => {});
    await this.flushUserBuffer(GLOBAL_SPAM_USER_ID).catch(() => {});
  }

  async recordUserJudgment(userId, msg, judgment) {
    if (!this.enabled) return;
    const text = msg.text || msg.caption || '';
    if (!text) return;
    const messages = [
      { role: 'user', content: text },
      { role: 'assistant', content: `AI判定: ${judgment.spam ? 'SPAM' : 'CLEAN'}. 理由: ${judgment.reason || '无'}` }
    ];
    await this._insertBlob(userId, messages).catch(() => {});
  }

  async flushUserBuffer(userId) {
    if (!this.enabled) return;
    try {
      await this.apiCall(`/memobase/api/v1/users/buffer/${userId}/chat`, 'POST');
    } catch (e) {
      logError('Memobase', 'flushUserBuffer failed', e);
    }
  }

  async _insertBlob(userId, messages) {
    const body = {
      blob_type: 'chat',
      blob_data: { messages }
    };
    await this.apiCall(`/memobase/api/v1/blobs/insert/${userId}`, 'POST', body);
  }

  async apiCall(path, method, body = null) {
    if (!this.apiKey) throw new Error('MEMOBASE_API_KEY not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      };
      if (body) options.body = JSON.stringify(body);

      const response = await fetch(`${BASE_URL}${path}`, options);
      clearTimeout(timer);
      if (!response.ok) throw new Error(`Memobase API ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createMemobaseService(env) {
  return new MemobaseService(env);
}
