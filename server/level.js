// 级别系统：两队各自记录 levelIndex。
// 级别序列：0=打2 … 12=打A，13=第二圈的2，≥14=获胜。
// A 升一级回到 2（第13级），在第二圈的 2 上再升一级获胜（第14级）。

export const LEVEL_SEQUENCE = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 2]);

// levelIndex → 本局级牌点数（第二圈的 2 打牌时与普通 2 完全一样）
export function rankOfLevel(levelIndex) {
  return (levelIndex % 13) + 2;
}

export function isVictory(levelIndex) {
  return levelIndex >= 14;
}

// 队伍升级：一次升多级可直接跨到胜利（如打 K 升 3 级 → 当场获胜）
export function applyUpgrades(teamLevels, team, count) {
  const levels = [...teamLevels];
  levels[team] += count;
  return { levels, winningTeam: isVictory(levels[team]) ? team : null };
}
