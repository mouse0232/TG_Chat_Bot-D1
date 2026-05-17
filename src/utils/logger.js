const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SILENT: 4 };
let currentLevel = LOG_LEVELS.INFO;

export function setLogLevel(level) {
  const v = LOG_LEVELS[level];
  if (v !== undefined) currentLevel = v;
}

export function initLogger(env) {
  setLogLevel(env?.LOG_LEVEL || 'INFO');
}

export function genRequestId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'r_' + Array.from(bytes, b => b.toString(36)).join('');
}

export class BusinessError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function format(level, tag, msg, ctx) {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] [${tag}] ${msg}`;
  if (ctx && typeof ctx === 'object' && Object.keys(ctx).length) {
    line += ' ' + JSON.stringify(ctx);
  }
  return line;
}

function output(level, tag, msg, ctx) {
  if (currentLevel > LOG_LEVELS[level] && level !== 'ERROR') return;
  const fn = level === 'ERROR' ? console.error
           : level === 'WARN' ? console.warn
           : console.log;
  fn(format(level, tag, msg, ctx));
}

export const log = {
  debug: (tag, msg, ctx) => output('DEBUG', tag, msg, ctx),
  info:  (tag, msg, ctx) => output('INFO', tag, msg, ctx),
  warn:  (tag, msg, ctx) => output('WARN', tag, msg, ctx),
  error: (tag, msg, ctx) => output('ERROR', tag, msg, ctx),
};

export function logError(tag, msg, err, ctx = {}) {
  const details = { ...ctx, error: err?.message || String(err), stack: err?.stack?.split('\n')[0] };
  output('ERROR', tag, msg, details);
}

export function sqlOp(q) {
  const m = q.match(/^(INSERT|UPDATE|DELETE|SELECT|REPLACE|ALTER|CREATE)/i);
  return m ? m[1].toUpperCase() : 'QUERY';
}

export function sqlTable(q) {
  const m = q.match(/(?:INTO|FROM|UPDATE|TABLE)\s+(\w+)/i);
  return m ? m[1] : 'unknown';
}