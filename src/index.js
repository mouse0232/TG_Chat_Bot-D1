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
  }
};
