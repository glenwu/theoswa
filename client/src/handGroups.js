import { playSuitOf } from '../../server/cards.js';

// 手牌分组结构（纯展示逻辑）：
// 输入已排序的手牌，输出 [{ suit: 'TRUMP'|花色, count, color: 'red'|'black'|null }]。
// 用于：组间间隔（同色相邻加宽）、组张数角标（>5 张显示）。
export function handGroups(hand, trumpSuit, rankCard) {
  const groups = [];
  for (const card of hand) {
    const suit = playSuitOf(card, trumpSuit, rankCard);
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

// 组张数角标：超过 5 张才显示（5 张不显示、6 张显示）
export function groupBadgeCount(group) {
  return group.count > 5 ? group.count : null;
}

// 两个相邻副牌组之间是否需要“明显间隔”（同色且无法交替时）
export function needWideGap(prev, next) {
  return (
    prev.color !== null &&
    next.color !== null &&
    prev.color === next.color
  );
}
