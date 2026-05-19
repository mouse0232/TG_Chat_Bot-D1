export const MEMORY_CONTEXT_TEMPLATE = `

## 🔴 历史纠正经验参考 (全局与个人)
以下是该类型消息的历史判定经验及管理员纠正记录，请在判定时重点参考：
{{memoryContext}}

## 判定注意事项
- 若记忆中包含"管理员确认是垃圾信息"的记录，请提高判定为 SPAM 的倾向。
- 若记忆中包含"管理员确认非垃圾信息"的记录，请提高判定为 CLEAN 的倾向。
- 记忆仅供参考，最终请结合当前消息内容进行独立判断。
`;

export function enhanceSystemPrompt(basePrompt, memoryContext) {
  if (!memoryContext || memoryContext.trim() === '') return basePrompt;
  return basePrompt + MEMORY_CONTEXT_TEMPLATE.replace('{{memoryContext}}', memoryContext);
}
