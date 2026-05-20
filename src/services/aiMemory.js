/**
 * AI Memory Service
 * Manages long-term memory for AI spam detection using D1 storage.
 * Includes writing corrections, retrieving context, and summarizing rules via LLM.
 */

import { log, logError } from '../utils/logger.js';
import { callLlmApi } from '../security/aiAntiHarassment.js';
import { MEMORY_INJECT_TEMPLATE, SUMMARIZE_PROMPT_TEMPLATE } from '../security/aiMemoryPrompt.js';

const HOT_CORRECTION_LIMIT = 3; // Limit of recent corrections to inject into prompt

/**
 * Write a correction record to the D1 database.
 * @param {string} userId - The user ID involved in the correction.
 * @param {string} userMsg - The original message content.
 * @param {string} originalJudgment - AI's original judgment ('SPAM' or 'CLEAN').
 * @param {string} correctResult - The corrected result ('SPAM' or 'CLEAN').
 * @param {string} reason - Reason for correction.
 * @param {Object} env - Environment variables containing D1 binding.
 */
export async function addCorrection(userId, userMsg, originalJudgment, correctResult, reason, env) {
  try {
    const db = env.TG_BOT_DB;
    await db.prepare(
      'INSERT INTO ai_corrections (user_id, user_msg, original_judgment, correct_result, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(userId, userMsg.substring(0, 512), originalJudgment, correctResult, reason || '', Date.now()).run();
    log.info('AiMemory', 'Correction added', { userId, result: correctResult });
  } catch (e) {
    logError('AiMemory', 'Failed to add correction', e);
  }
}

/**
 * Retrieve memory context (long-term rules + recent corrections).
 * @param {Object} env - Environment variables.
 * @returns {Promise<{longTermRules: string, recentCorrections: string}>}
 */
export async function getMemoryContext(env) {
  try {
    const db = env.TG_BOT_DB;
    
    // Get long-term rules
    const rulesRes = await db.prepare("SELECT content FROM ai_rules WHERE id = 1").first();
    const longTermRules = rulesRes?.content || '';
    
    // Get recent hot corrections (limit 3)
    const recentRes = await db.prepare(
      "SELECT user_msg, correct_result, reason FROM ai_corrections ORDER BY created_at DESC LIMIT ?"
    ).bind(HOT_CORRECTION_LIMIT).all();
    
    const recentCorrections = recentRes.results.map(r => 
      `- 原文: "${r.user_msg.substring(0, 80)}..." → 纠正为: ${r.correct_result}${r.reason ? ` (${r.reason})` : ''}`
    ).join('\n');
    
    return { longTermRules, recentCorrections };
  } catch (e) {
    logError('AiMemory', 'Failed to get memory context', e);
    return { longTermRules: '', recentCorrections: '' };
  }
}

/**
 * Build an enhanced System Prompt with memory context.
 * @param {string} basePrompt - The original system prompt.
 * @param {Object} env - Environment variables.
 * @returns {Promise<string>} The enhanced prompt.
 */
export async function buildPromptWithMemory(basePrompt, env) {
  // Default follow mode: enabled unless explicitly set to 'false'
  if (env.ENABLE_AI_MEMORY === 'false') return basePrompt;

  const { longTermRules, recentCorrections } = await getMemoryContext(env);
  
  if (!longTermRules && !recentCorrections) return basePrompt;
  
  try {
    return basePrompt + MEMORY_INJECT_TEMPLATE
      .replace('{{long_term_rules}}', longTermRules || '暂无积累')
      .replace('{{recent_corrections}}', recentCorrections || '暂无');
  } catch (e) {
    logError('AiMemory', 'Failed to build prompt with memory, falling back', e);
    return basePrompt;
  }
}

/**
 * Summarize unprocessed corrections into general rules (Called by Cron Job).
 * @param {Object} env - Environment variables.
 */
export async function summarizeCorrections(env) {
  try {
    const db = env.TG_BOT_DB;
    
    // Query unsummarized corrections
    const records = await db.prepare(
      "SELECT user_msg, original_judgment, correct_result, reason FROM ai_corrections WHERE is_summarized = 0 ORDER BY created_at ASC LIMIT 50"
    ).all();
    
    if (records.results.length === 0) {
      log.info('AiMemory', 'No new corrections to summarize');
      return;
    }
    
    // Get existing rules
    const rulesRes = await db.prepare("SELECT content FROM ai_rules WHERE id = 1").first();
    const existingRules = rulesRes?.content || '无';
    
    // Prepare correction data for LLM
    const correctionLines = records.results.map(r => 
      `"${r.user_msg.substring(0, 80)}" | AI: ${r.original_judgment} | 正确: ${r.correct_result} | 理由: ${r.reason || '无'}`
    ).join('\n');
    
    // Build summary prompt
    const summarizePrompt = SUMMARIZE_PROMPT_TEMPLATE
      .replace('{{existing_rules}}', existingRules)
      .replace('{{new_corrections}}', correctionLines);
    
    // Call LLM to summarize
    const newRules = await callLlmApi(env, '你是一个反骚扰规则提炼专家。请根据输入提炼规则，只输出规则列表。', summarizePrompt);
    
    if (newRules && newRules.length > 0) {
      // Update rules and mark corrections as summarized
      await db.batch([
        db.prepare("UPDATE ai_rules SET content = ?, updated_at = ? WHERE id = 1").bind(newRules, Date.now()),
        db.prepare("UPDATE ai_corrections SET is_summarized = 1 WHERE is_summarized = 0")
      ]);
      log.info('AiMemory', `Summarized ${records.results.length} corrections into rules`);
    } else {
      log.warn('AiMemory', 'LLM returned empty rules, skipping update');
    }
  } catch (e) {
    logError('AiMemory', 'Summarization failed', e);
  }
}
