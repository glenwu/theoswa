// 埋底亮件的大图：庄家埋进底牌的副 A/K 是【强制公开】的（handleBuryKitty），
// 可原来只在牌桌中央那一排底牌背面旁边露一个小标签，没人会注意到。
//
// Glen 2026-09-06：「如果庄家埋底有件，把件大一点显示在屏幕中间，停留 3 秒，
//   然后动态效果收到放埋底的 8 张牌那边。」
//
// 两段：hold（大图停在中间）→ fly（飞进底牌那一排）→ 结束。
// 起点用服务端的 round.kittyBuriedAt，不用各端自己的收包时刻 ——
// 否则四家看到的长短不一样，慢的那家可能整段都错过。
export const KITTY_SPOTLIGHT_HOLD_MS = 3000;
export const KITTY_SPOTLIGHT_FLY_MS = 700;

// 这一刻该显示哪一段：'hold' | 'fly' | null。
// ⚠️ 阶段闸不是「只在 PLAYING」：埋完底先进 CROSS_RIVER（三主过河），
// 没人够格才马上进 PLAYING。窗口只有 3.7 秒，过河那 15 秒的决策窗一开，
// 只认 PLAYING 的话这段大图就整个错过了。
export function kittySpotlightStage(game, now) {
  const round = game?.round;
  if (!round) return null;
  if (game.phase !== 'CROSS_RIVER' && game.phase !== 'PLAYING') return null;
  if ((round.kittyRevealedPieces?.length ?? 0) === 0) return null;   // 没埋件，没什么可亮
  const from = round.kittyBuriedAt;
  if (!from) return null;
  const elapsed = now - from;
  if (elapsed < 0) return null;                                      // 时钟偏差，别倒着放
  if (elapsed < KITTY_SPOTLIGHT_HOLD_MS) return 'hold';
  if (elapsed < KITTY_SPOTLIGHT_HOLD_MS + KITTY_SPOTLIGHT_FLY_MS) return 'fly';
  return null;
}
