// 「吊主」气泡判定（纯函数）：
// 首家出主牌，且上一轮首家出的不是主牌时触发。
// 本局第一轮首家出主牌也触发；连续多轮主牌领出只在第一轮触发一次；
// 副牌 → 主牌 → 副牌 → 主牌 会再次触发。

export function tiaoZhuActive(currentTrick, trickHistory) {
  if (!Array.isArray(currentTrick) || currentTrick.length !== 1) return false;
  const lead = currentTrick[0];
  if (!lead || lead.playSuit !== 'TRUMP') return false;
  const prev =
    Array.isArray(trickHistory) && trickHistory.length > 0
      ? trickHistory[trickHistory.length - 1]
      : null;
  if (prev && prev.leadSuit === 'TRUMP') return false; // 连续主牌领出只弹一次
  return true;
}
