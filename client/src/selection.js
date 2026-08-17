// 手牌选中纯逻辑（出牌甩牌与换底共用，客户端与服务端动作之间只做本地提示）：
//   tapToggle：单击切换 —— 已选则取消，未选则加选（受上限约束）
//   dragAdd  ：拖动只加选（add-only）—— 拖回已选牌绝不取消（取消交给单击与「清空选择」）
//   selectionCapFor：出牌阶段无上限；换底阶段上限 8 张
export function tapToggle(selected, id, cap) {
  return selected.includes(id)
    ? selected.filter(x => x !== id)
    : selected.length >= cap
      ? selected
      : [...selected, id];
}

export function dragAdd(selected, id, cap) {
  return selected.includes(id) || selected.length >= cap ? selected : [...selected, id];
}

export function selectionCapFor(phase) {
  return phase === 'KITTY_EXCHANGE' ? 8 : Infinity;
}
