// 「看上一轮」要展示的那一墩（Glen 2026-10-06）。
//
// 取最近一墩【打完的】：trickHistory 的末尾。
// ⚠️ 跳过 virtual 墩 —— 碾压收尾补的那一手 plays 是空的，没有牌可看。
// 停留展示期（round.lastTrick 非空）取到的就是桌上那一墩，和牌桌显示一致。
export function lastFinishedTrick(round) {
  const history = round?.trickHistory ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const trick = history[i];
    if (trick?.virtual) continue;
    if ((trick?.plays ?? []).length === 0) continue;
    return trick;
  }
  return null;
}

// 出牌顺序就是 plays 的顺序（服务端按座位轮转 push）。
// 领牌人、赢家各挂一个标记，分数挂在整墩上。
export function lastTrickRows(trick) {
  const plays = trick?.plays ?? [];
  return plays.map((play, index) => ({
    seat: play.seat,
    cards: play.cards ?? [],
    isLead: index === 0,
    isWinner: play.seat === trick?.winnerSeat,
  }));
}
