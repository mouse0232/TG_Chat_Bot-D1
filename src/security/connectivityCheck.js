/**
 * AI / TMS / Green 反骚扰可用性检测
 * 在管理员开启功能前验证配置是否正确、API 是否可达
 */

import { callLlmApi } from './aiAntiHarassment.js';
import { callTmsApi } from './tencentTms.js';
import { callGreenApi } from './aliyunGreen.js';

const AI_TEST_PROMPT = "你好";
const TMS_TEST_TEXT = "test";
const GREEN_TEST_TEXT = "test";

/**
 * 检测 AI 反骚扰可用性
 * 发送极短文本，验证 LLM API 可达、密钥有效、响应格式正确
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { ok: boolean, latencyMs: number, error: string|null }
 */
export async function checkAiConnectivity(env) {
  if (!env.LLM_KEY) return { ok: false, latencyMs: 0, error: "LLM_KEY 未配置" };

  const start = Date.now();
  try {
    const judgment = await callLlmApi(
      env,
      "Reply only: CLEAN",
      AI_TEST_PROMPT
    );
    const latencyMs = Date.now() - start;
    if (typeof judgment !== "string" || !judgment.trim()) {
      return { ok: false, latencyMs, error: "LLM 返回格式异常: " + String(judgment).substring(0, 50) };
    }
    return { ok: true, latencyMs, error: null };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err.name === "AbortError" ? "API 超时" : err.message;
    return { ok: false, latencyMs, error: msg };
  }
}

/**
 * 检测 TMS 反骚扰可用性
 * 发送短文本，验证密钥有效、签名正确、API 可达、响应结构正确
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { ok: boolean, latencyMs: number, error: string|null, label: string|null, suggestion: string|null }
 */
export async function checkTmsConnectivity(env) {
  if (!env.TENCENT_SECRET_ID || !env.TENCENT_SECRET_KEY) {
    return { ok: false, latencyMs: 0, error: "TENCENT_SECRET_ID/TENCENT_SECRET_KEY 未配置" };
  }

  const start = Date.now();
  try {
    const result = await callTmsApi(env, TMS_TEST_TEXT);
    const latencyMs = Date.now() - start;

    if (result.Error) {
      return { ok: false, latencyMs, error: `${result.Error.Code}: ${result.Error.Message}` };
    }

    if (!result.Suggestion || !result.Label) {
      return { ok: false, latencyMs, error: "TMS 响应结构异常" };
    }

    return { ok: true, latencyMs, error: null, label: result.Label, suggestion: result.Suggestion };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err.name === "AbortError" ? "API 超时" : err.message;
    return { ok: false, latencyMs, error: msg };
  }
}

/**
 * 检测 Green 反骚扰可用性
 * 发送短文本，验证密钥有效、签名正确、API 可达、响应结构正确
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} { ok: boolean, latencyMs: number, error: string|null, riskLevel: string|null }
 */
export async function checkGreenConnectivity(env) {
  if (!env.ALIYUN_ACCESS_KEY_ID || !env.ALIYUN_ACCESS_KEY_SECRET) {
    return { ok: false, latencyMs: 0, error: "ALIYUN_ACCESS_KEY_ID/SECRET 未配置" };
  }

  const start = Date.now();
  try {
    const result = await callGreenApi(env, GREEN_TEST_TEXT);
    const latencyMs = Date.now() - start;

    if (result.Code !== 200) {
      return { ok: false, latencyMs, error: `Code ${result.Code}: ${result.Message}` };
    }

    const riskLevel = result.Data?.RiskLevel;
    if (!riskLevel) {
      return { ok: false, latencyMs, error: "Green 响应结构异常：缺少 RiskLevel" };
    }

    return { ok: true, latencyMs, error: null, riskLevel };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err.name === "AbortError" ? "API 超时" : err.message;
    return { ok: false, latencyMs, error: msg };
  }
}