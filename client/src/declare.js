// 亮主有哪几个选择 —— 控制栏的按钮和数字键快捷键共用这一份。
//
// Glen 2026-09-06：「可以亮主的时候，有时候会有多个选择，现在只有一个按钮，
//   可以做成多个按钮放同一行，就显示『亮♠』这样的信息就可以了。」
//
// 选择的单位是【花色】不是【张】：handleDeclareTrump 只认 card.suit，
// 同花色的两张级牌亮出来结果一模一样，摆两个按钮只会让人以为有两种亮法。
// 顺序按手牌里第一次出现的花色排，这样同一手牌每次进来编号都稳定。
export function declareOptions(hand, rankCard) {
  const out = [];
  const seen = new Set();
  for (const card of hand ?? []) {
    if (!card || card.rank !== rankCard || rankCard === null || rankCard === undefined) continue;
    if (seen.has(card.suit)) {
      out[out.findIndex(item => item.suit === card.suit)].count += 1;
      continue;
    }
    seen.add(card.suit);
    out.push({ suit: card.suit, cardId: card.id, count: 1 });
  }
  return out;
}
