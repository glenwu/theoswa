// 上线提示的纯逻辑（无 DOM，可单测）。
//
// 服务端在真人上线时往 log 里写一条带 { event: 'ONLINE', playerId } 的系统消息。
// 客户端的难点不在渲染，在于「哪些算新的」：
//   1. 一进房间就会收到最近 200 条历史日志 —— 里面躺着今天所有人的上线记录。
//      不立基线的话，刚连上就被一串陈年提示糊满屏。
//   2. 每次状态广播都会重发整条 log（不是增量），所以同一条会反复出现，
//      必须按 key 去重，否则每出一张牌就重弹一次。
//   3. 自己的上线不弹给自己 —— 你自己知道你上线了。

export function onlineKey(entry) {
  return `${entry.playerId}-${entry.ts}`;
}

// 从整条日志里挑出上线事件（已排除自己）。
export function onlineEventsIn(log, selfId) {
  return (log ?? []).filter(
    l => l && l.event === 'ONLINE' && l.playerId && l.playerId !== selfId
  );
}

// 增量计算：给定日志与「已看过的 key 集合」，返回本次新增的事件。
// 传入 seen === null 表示首帧 —— 此时不弹任何提示，只把现有事件全部收进基线。
// 返回 { fresh, seen }：seen 是更新后的集合（新建，不原地改，方便测试与 React 比较）。
export function nextOnlineToasts(log, selfId, seen) {
  const events = onlineEventsIn(log, selfId);
  const keys = events.map(onlineKey);
  if (seen === null || seen === undefined) {
    return { fresh: [], seen: new Set(keys) };
  }
  const fresh = events.filter(e => !seen.has(onlineKey(e)));
  if (fresh.length === 0) return { fresh, seen };
  return { fresh, seen: new Set([...seen, ...fresh.map(onlineKey)]) };
}
