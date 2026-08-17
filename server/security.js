// 状态裁剪安全底线：payload 中不允许出现任何非公开的牌面数据。
// 判定不是靠字段名（hand 之类）——递归遍历整个 payload，
// 凡是符合 Card 形状（id:string + suit:string + rank:number）的对象，
// 且不在白名单路径下（本人手牌、公开翻开的牌、已打出的牌），一律视为泄露。

export function isCardLike(node) {
  return (
    !!node &&
    typeof node === 'object' &&
    typeof node.id === 'string' &&
    typeof node.suit === 'string' &&
    typeof node.rank === 'number'
  );
}

// 返回所有泄露的卡片：{ path, card }[]
export function collectLeakedCards(payload, allowedPrefixes) {
  const leaks = [];
  const walk = (node, path) => {
    if (isCardLike(node)) {
      const allowed = allowedPrefixes.some(p => path === p || path.startsWith(p + '.'));
      if (!allowed) leaks.push({ path, card: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : String(k));
      }
    }
  };
  walk(payload, '');
  return leaks;
}
