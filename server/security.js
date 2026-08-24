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
//
// ⚠️ 这是全项目的安全底线（viewer.js 的唯一出口），性能优化不许削弱它。
// 实测它占电脑对局总 CPU 的 17% —— 每次广播、对每个玩家都要扫一遍完整 payload，
// 而这个成本随人数和消息频率放大，正是服务器最吃不消的那一类。
//
// 两处等价优化（语义一字不差，有 security.test.js 的等价性测试盯着）：
//   1. 【进入白名单子树就整棵跳过】—— 原判据是 path === p || path.startsWith(p + '.')，
//      也就是说白名单子树【里面的一切本来就都是允许的】，再往下扫纯属白扫。
//      而最大的那几个数组（trickHistory / currentTrick / you.hand）恰恰全在白名单里。
//   2. 【路径字符串只在真找到泄露时才拼】—— 原来每到一个键都要拼一次
//      `${path}.${k}`，绝大多数拼出来只是为了立刻丢掉。
export function collectLeakedCards(payload, allowedPrefixes) {
  const leaks = [];
  const allowed = allowedPrefixes.map(prefix => prefix.split('.'));
  const maxPrefixLen = allowed.reduce((max, p) => Math.max(max, p.length), 0);

  // keys 是从根到当前节点的键路径。允许前缀最长就 maxPrefixLen 段，
  // 更深的地方不可能是「刚进入某个白名单子树」，不必再比。
  const insideAllowed = keys =>
    keys.length <= maxPrefixLen &&
    allowed.some(p => p.length === keys.length && p.every((seg, i) => seg === keys[i]));

  const walk = (node, keys) => {
    if (isCardLike(node)) {
      leaks.push({ path: keys.join('.'), card: node });
      return;
    }
    if (Array.isArray(node)) {
      // 数组不加一层路径（与原实现一致：`walk(item, path)`）
      for (const item of node) walk(item, keys);
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const next = [...keys, key];
        if (insideAllowed(next)) continue; // 整棵跳过
        walk(node[key], next);
      }
    }
  };
  walk(payload, []);
  return leaks;
}
