import { playSuitOf, revealGroupOf } from '../../server/cards.js';

// 手牌分组结构（纯展示逻辑）：
// 输入已排序的手牌，输出 [{ suit: 'TRUMP'|花色, count, color: 'red'|'black'|null }]。
// 用于：组间间隔（同色相邻加宽）、组张数角标（>5 张显示）。
//
// 主牌未定时（揭牌阶段 trumpSuit === null）改用 revealGroupOf 归组：
// 只有鬼自成一组，级牌 2 留在它自己的花色里。
// ⚠️ 此时不能用 playSuitOf —— 它会把四门的 2 全判成 TRUMP，
// 于是每张 2 都在花色组中间切出一个假的"主牌组"，分组彻底碎掉。
export function handGroups(hand, trumpSuit, rankCard) {
  const classify = trumpSuit
    ? card => playSuitOf(card, trumpSuit, rankCard)
    : revealGroupOf;
  const groups = [];
  for (const card of hand) {
    const suit = classify(card);
    const last = groups[groups.length - 1];
    if (last && last.suit === suit) {
      last.count += 1;
    } else {
      groups.push({
        suit,
        count: 1,
        color: suit === 'TRUMP' ? null : suit === 'H' || suit === 'D' ? 'red' : 'black',
      });
    }
  }
  return groups;
}

// 组张数角标：5 张及以上显示（5 张显示、4 张不显示）。
// 角标同时是「整组全选」的按钮，所以门槛比纯提示时低一档 —— 一次点 5 张也值得。
export function groupBadgeCount(group) {
  return group.count >= 5 ? group.count : null;
}

// 两个相邻副牌组之间是否需要“明显间隔”（同色且无法交替时）
export function needWideGap(prev, next) {
  return (
    prev.color !== null &&
    next.color !== null &&
    prev.color === next.color
  );
}

// 把若干「花色组」划成 rows 行，使【最宽的一行】尽可能窄（最优划分，DP）。
// 返回每行的 [起, 止) 下标区间。
//
// ⚠️ 不能用贪心（逐组累加、超过「总宽/行数」就换行）：
// 贪心会把一整组挤到下一行，造出一条超宽的行 —— 实测出现过某行 423px 而可用宽只有 320px，
// 第二行直接溢出到屏幕两侧。最优划分把同样的组重新分配后是 300/240，两行都放得下。
//
// 组是最小单位：绝不把同一花色拦腰截断（截断后同花色分处两行，极难读）。
export function partitionByWidth(widths, rows) {
  const n = widths.length;
  if (n === 0) return [];
  const R = Math.max(1, Math.min(rows, n));
  if (R === 1) return [[0, n]];

  const prefix = [0];
  for (let i = 0; i < n; i++) prefix.push(prefix[i] + widths[i]);
  const spanW = (a, b) => prefix[b] - prefix[a]; // [a, b)

  // dp[r][i]：用 r 行覆盖前 i 组时，最宽那行的最小值；cut 记录回溯用的切点
  const dp = Array.from({ length: R + 1 }, () => new Array(n + 1).fill(Infinity));
  const cut = Array.from({ length: R + 1 }, () => new Array(n + 1).fill(0));
  dp[0][0] = 0;
  for (let r = 1; r <= R; r++) {
    for (let i = r; i <= n; i++) {
      for (let j = r - 1; j < i; j++) {
        const val = Math.max(dp[r - 1][j], spanW(j, i));
        if (val < dp[r][i]) {
          dp[r][i] = val;
          cut[r][i] = j;
        }
      }
    }
  }

  const bounds = [n];
  let i = n;
  for (let r = R; r >= 1; r--) {
    i = cut[r][i];
    bounds.unshift(i);
  }
  const out = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    if (bounds[k + 1] > bounds[k]) out.push([bounds[k], bounds[k + 1]]);
  }
  return out;
}
