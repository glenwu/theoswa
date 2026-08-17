// 键盘快捷键的纯判定逻辑（不含 DOM 副作用，便于单元测试）。

// 输入框聚焦时全部快捷键失效（打字时按空格绝不能触发抓牌/出牌）
export function isTypingTarget(element) {
  if (!element) return false;
  const tag = String(element.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || Boolean(element.isContentEditable);
}

// 根据按键与游戏上下文决定动作：
// - 空格：轮到自己揭牌 → drawCard；出牌阶段已选中牌 → play；其余情况只拦截滚动
// - 数字 1-9：揭牌阶段立即亮出第 N 张可亮级牌（与牌上角标一一对应）
// 返回 null 表示不处理（含输入框聚焦时）。
export function shortcutAction(event, context) {
  if (!event || !event.key) return null;
  if (isTypingTarget(event.target)) return null;
  const key = event.key;

  if (key === ' ') {
    // 无论是否触发动作，都要拦截空格默认滚动（页面不该因空格跳动）
    const action = { preventDefault: true, type: null };
    if (context.phase === 'REVEALING' && context.myRevealTurn) {
      action.type = 'drawCard';
    } else if (context.phase === 'PLAYING' && context.myPlayTurn && context.selectedIds.length > 0) {
      action.type = 'play';
      action.cardIds = context.selectedIds;
    }
    return action;
  }

  if (/^[1-9]$/.test(key) && context.phase === 'REVEALING') {
    const index = Number(key) - 1;
    if (index < context.rankCardIds.length) {
      return { type: 'declareTrump', cardId: context.rankCardIds[index], preventDefault: false };
    }
  }
  return null;
}
