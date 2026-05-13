/**
 * Worker 入口文件
 */

import { dbInit } from './database/index.js';
import { route } from './router/index.js';

export default {
  async fetch(req, env, ctx) {
    ctx.waitUntil(dbInit(env).catch(e => console.error("DB Init Failed:", e)));
    return route(req, env, ctx);
  }
};
