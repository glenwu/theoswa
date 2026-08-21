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

// 整组全选 / 全不选（点手牌上的组张数角标触发）：
//   组内全部已选 → 取消整组；否则把组内未选的补进来，受上限约束（换底 8 张、过河 3 张）。
// 上限不足以装下整组时只补到满 —— 不报错、不清空已选，玩家再自己微调。
export function toggleGroup(selected, ids, cap) {
  if (!Array.isArray(ids) || ids.length === 0) return selected;
  if (ids.every(id => selected.includes(id))) {
    return selected.filter(id => !ids.includes(id));
  }
  const merged = [...selected];
  for (const id of ids) {
    if (merged.length >= cap) break;
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}
