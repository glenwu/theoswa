// 变异测试：吊主 / 保底 / 埋底 / 求件。
// ⚠️ 锚点写的是源码原文，改代码时锚点会失效变成 SKIP —— 一套满是 SKIP 的
// 变异测试是虚假的安全感，发现 SKIP 要立刻把锚点更新到当前代码。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '    if (drawBonus > 0) {', '    if (false && drawBonus > 0) {', '拿掉持续吊主（回到「只吊一轮」）'],
  [F, "role === 'declarer' ? (trumpSignalAnswered(view, ctx) ? 0 : 520)",
      "role === 'declarer' ? 0", '庄家不再续吊'],
  [F, "        ? (declarerLeadStyle(view) === 'trump' &&\n           !(hasBigJoker && declarerTrumpPointSignal(view, ctx)) ? 480 : 0)",
      '        ? 480', '队友做庄时不看庄家路子，一律吊主'],
  [F, '!control.guaranteed && (!strongSide || planPending)', 'true', '有保底牌/副牌强也照吊不误'],
  [F, '(trumpSignalAnswered(view, ctx) ? 0 : 520)', '520', '庄家不看队友答没答，照旧死吊'],
  [F, 'card.rank === 15 || card.rank === 16)) return true;', 'card.rank >= 3)) return true;',
      '随便跟一张主也算「不用吊主」的应答'],
  [F, '  if (!declarerTrumpPointSignal(view, ctx)) return false;', '',
      '没发过求大鬼的信号也当成收到了应答'],
  [F, `  return history.slice(1).some(
    trick => trick.leadSeat === partner && trick.leadSuit !== 'TRUMP'
  );`, '  return false;', '不认「队友吃下后转领副牌」这种应答'],
  [F, '(!strongSide || planPending)', '(true)', '副牌再强也死吊主'],
  [F, 'if (tier.mine > 0 && threats < mineAtOrAbove)', 'if (tier.mine > 0 && threats === 0)',
      '保底判定退回「独占顶档」（丢掉张数对比）'],
  [F, 'if (tier.mine > 0 && threats < mineAtOrAbove)', 'if (tier.mine > 0 && threats <= mineAtOrAbove)',
      '保底判定把「刚好换得完」也当成保底'],
  [F, `    mineAtOrAbove += tier.mine;
    threats += tier.total - tier.played - tier.mine; // 别人手上或底牌里
    if (tier.mine > 0 && threats < mineAtOrAbove) { holdsTopTrump = true; break; }`,
      `    mineAtOrAbove += tier.mine;
    if (tier.mine > 0 && threats < mineAtOrAbove) { holdsTopTrump = true; break; }
    threats += tier.total - tier.played - tier.mine;`,
      '同档的威胁先判后加（等于不把同强度算成威胁）'],
  [F, 'holdsTopTrump && myTrumps.length >= BOTTOM_MIN_TRUMPS', 'holdsTopTrump', '保底判定不看主牌长度'],
  [F, 'const BOTTOM_MIN_TRUMPS = 9;', 'const BOTTOM_MIN_TRUMPS = 3;', '保底的主牌长度门槛降到 3'],
  [F, 'cost += buriedHere.filter(card => card.rank === 14).length * 300;', '', '埋副 A 不再受罚'],
  [F, 'if (mine >= 1 && unseen >= 1 &&', 'if (unseen >= 2 &&', '求件回到不看自己有没有件'],
  [F, 'if (!stillHasSuit) continue;', '', '断门也照罚「件被埋光」（会让该断的门不敢断）'],
]);
