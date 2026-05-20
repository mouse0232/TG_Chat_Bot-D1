/**
 * Worker 入口文件
 */

import { dbInit } from './database/index.js';
import { route } from './router/index.js';
import { initLogger, logError } from './utils/logger.js';

export default {
  async fetch(req, env, ctx) {
    initLogger(env);
    ctx.waitUntil(dbInit(env).catch(e => logError('Worker', 'DB init failed', e)));
    return route(req, env, ctx);
  },

  async scheduled(event, env, ctx) {
    // 默认跟随模式：除非显式关闭，否则只要 AI 开启就执行总结
    if (env.ENABLE_AI_MEMORY !== 'false') {
      try {
        const { summarizeCorrections } = await import('./services/aiMemory.js');
        ctx.waitUntil(summarizeCorrections(env));
      } catch (e) {
        logError('Cron', 'Failed to load aiMemory', e);
      }
    }
  }
};
