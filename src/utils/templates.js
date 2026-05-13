/**
 * HTML 模板
 * 包含验证页面等 HTML 模板
 */

import { escapeHTML } from './helpers.js';

/**
 * 生成验证页面 HTML
 * @param {string} uid - 用户 ID
 * @param {string} nonce - 验证 nonce
 * @param {string} mode - 验证模式 (turnstile/recaptcha)
 * @param {string} siteKey - 站点密钥
 * @returns {string}
 */
export function getVerifyPageHtml(uid, nonce, mode, siteKey) {
  const script = mode === "recaptcha" 
    ? "https://www.google.com/recaptcha/api.js" 
    : "https://challenges.cloudflare.com/turnstile/v0/api.js";
  const divClass = mode === "recaptcha" ? "g-recaptcha" : "cf-turnstile";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="${script}" async defer></script>
<style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;font-family:sans-serif}
#c{text-align:center;padding:20px;background:#f0f0f0;border-radius:10px;max-width:92vw}
</style></head><body><div id="c"><h3>🛡️ 安全验证</h3>
<div class="${divClass}" data-sitekey="${siteKey}" data-callback="S"></div><div id="m"></div></div>
<script>
const tg=window.Telegram.WebApp;tg.ready();
const UI_USER_ID='${escapeHTML(uid)}';
const UI_NONCE='${escapeHTML(nonce)}';
function S(t){
  document.getElementById('m').innerText='Wait...';
  const initData = tg.initData || "";
  fetch('/submit_token',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:t,userId:UI_USER_ID,nonce:UI_NONCE,initData})
  }).then(r=>r.json()).then(d=>{
    if(d.success){
      document.getElementById('m').innerText='✅';
      setTimeout(()=>{tg.close();try{window.close()}catch(e){}},800);
    }else{
      document.getElementById('m').innerText='❌';
    }
  }).catch(e=>{document.getElementById('m').innerText='Error'});
}
</script></body></html>`;
}
