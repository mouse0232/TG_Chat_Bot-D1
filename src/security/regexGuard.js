/**
 * ReDoS 防护
 */

import { REGEX_MAX_PATTERN_LEN, REGEX_MAX_TEXT_LEN, REGEX_REJECT_PATTERNS } from '../utils/constants.js';
import { log } from '../utils/logger.js';

/**
 * 安全正则测试
 * @param {string} pattern - 正则模式
 * @param {string} text - 测试文本
 * @returns {boolean}
 */
export function safeRegexTest(pattern, text) {
  try {
    if (!pattern || typeof pattern !== "string") return false;
    const p = pattern.trim();
    if (!p || p.length > REGEX_MAX_PATTERN_LEN) return false;

    for (const re of REGEX_REJECT_PATTERNS) {
      if (re.test(p)) return false;
    }

    const t = (text || "").toString();
    const t2 = t.length > REGEX_MAX_TEXT_LEN ? t.slice(0, REGEX_MAX_TEXT_LEN) : t;

    return new RegExp(p, "gi").test(t2);
  } catch(e) { log.warn('RegexGuard', 'Regex test failed, allowing', { error: e.message }); return false; }
}
