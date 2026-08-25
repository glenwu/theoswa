// 每个座位名字底下那句「他到底点没点」。纯函数，便于单测。
//
// ⚠️ 原来只覆盖 SEATING / READY_CHECK / 换底 / 过河。而【起揭停留】（点「知道了」）
// 和【本局小结】（点「看完了」）同样是在等四个人点，却什么都不显示 ——
// 四个人干等着，谁也不知道还差谁。加新的「等人点」阶段时务必同步这里。
//
// 返回 null 表示这个阶段没有「等谁」的语义，不显示胶囊（不硬凑文案、不误导）。
export function seatStatusText(game, player) {
  const round = game?.round;
  switch (game?.phase) {
    case 'SEATING':
      return player.seatLocked ? '已确认✓' : '未确认';
    case 'READY_CHECK':
      return player.ready ? '已准备✓' : '未准备';
    case 'REVEAL_FIRST':
      // 起揭人已定、正在停留等四家点「知道了」；还没翻出来时无所谓等谁
      if (!round?.flipDone) return null;
      return round.flipConfirms?.includes(player.seat) ? '已准备✓' : '未准备';
    case 'ROUND_END':
      return round?.roundEndConfirms?.includes(player.seat) ? '已看完✓' : '看小结中';
    case 'KITTY_EXCHANGE':
      return player.isDeclarer ? '换底中' : '等待换底';
    case 'CROSS_RIVER':
      return round?.crossRiver?.doneTeams?.includes(player.team) ? '已过河' : '过河阶段';
    default:
      return null;
  }
}

// 牌桌上的座位只显示【还没好】的那一半。
//
// 左栏玩家列表用 seatStatusText，确认态（已准备✓）也显示 —— 那是一览表，
// 看的是「四个人各自什么状态」。牌桌不一样：四个座位是所有人打牌时一直盯着的
// 地方，位置金贵，「已准备✓」放上去只是噪音，真正要一眼看到的是【还在等谁】。
// ⚠️ seatStatusText 加了新阶段时，如果新文案表示「已完成」，记得进 DONE。
const DONE = new Set(['已确认✓', '已准备✓', '已看完✓', '已过河']);

export function seatPendingText(game, player) {
  const text = seatStatusText(game, player);
  if (!text || DONE.has(text)) return null;
  return text;
}
