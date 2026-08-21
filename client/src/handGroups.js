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
