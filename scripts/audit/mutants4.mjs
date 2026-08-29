// 变异测试：吊主 / 保底 / 埋底 / 求件。
// ⚠️ 锚点写的是源码原文，改代码时锚点会失效变成 SKIP —— 一套满是 SKIP 的
// 变异测试是虚假的安全感，发现 SKIP 要立刻把锚点更新到当前代码。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '    if (drawBonus > 0) {', '    if (false && drawBonus > 0) {', '拿掉持续吊主（回到「只吊一轮」）'],
  [F, `        ? (trumpSignalAnswered(view, ctx) ||
           trumps.length <= maxOpponentTrumpEstimate(view, ctx) ? 0 : 520)`,
      '        ? 0', '庄家不再续吊'],
  // ⚠️ 判据 2026-08-29 换过：从 lastLeadStyle（庄家最近一次领什么）换成
  // declarerOpenedSide（庄家首出打的是不是副牌）。见 mutants29。
  [F, "        ? (declarerOpenedSide(view) ||\n           (hasBigJoker && declarerTrumpPointSignal(view, ctx)) ? 0 : 480)",
      '        ? 480', '队友不看庄家的表态，一律吊主'],
  [F, '!control.guaranteed && (!strongSide || planPending)', 'true', '有保底牌/副牌强也照吊不误'],
  [F, `trumpSignalAnswered(view, ctx) ||
           trumps.length <= maxOpponentTrumpEstimate(view, ctx) ? 0 : 520`,
      '520', '庄家不看队友答没答，照旧死吊'],
  [F, 'card.rank === 15 || card.rank === 16)) return true;', 'card.rank >= 3)) return true;',
      '随便跟一张主也算「不用吊主」的应答'],
  [F, '  if (!declarerTrumpPointSignal(view, ctx)) return false;', '',
      '没发过求大鬼的信号也当成收到了应答'],
  // ⚠️ 判据 2026-08-29 收紧了：应答是【第一次拿到牌权】那一手，不是
  // 「此后曾经领过副牌」。见 mutants29。
  [F, `  const firstPartnerLead = history.slice(1).find(trick => trick.leadSeat === partner);
  return !!firstPartnerLead && firstPartnerLead.leadSuit !== 'TRUMP';`,
      '  return false;', '不认「队友吃下后转领副牌」这种应答'],
  [F, '(!strongSide || planPending)', '(true)', '副牌再强也死吊主'],
  // ---- 清顶（Glen 纠正「永远不含鬼」之后加的） ----
  [F, 'const drawPool = clearing ? trumps : drawableTrumps;', 'const drawPool = drawableTrumps;',
      '清顶时鬼仍然不进候选（回到写死的绝对规则）'],
  [F, 'const clearing = trumpClearingOut(view, ctx, control);', 'const clearing = false;',
      '清顶整块失效'],
  [F, "mode: clearing ? 'clearing' : planPending ? 'tier' : 'low',",
      "mode: planPending ? 'tier' : 'low',", '清顶的档位没接上（候选放开了却还吊小牌）'],
  [F, "  if (mode === 'clearing') return highCards(trumps, 1, ctx)[0];",
      "  if (mode === 'clearing') return lowestLead(trumps, ctx);", '清顶时反而领最小的'],
  [F, '  if (top < 1) return false;                          // 顶端已经空了，没有大牌可撞', '',
      '顶端已经空了也去领鬼'],
  [F, '  if (top > CLEARING_MAX_TOP_OUTSTANDING) return false; // 顶上还有一大把，撞不干净', '',
      '清顶不看顶端还压着几张'],
  [F, 'return outstandingTrumpCount(view, ctx) - top <= CLEARING_MAX_LOW_OUTSTANDING;', 'return true;',
      '不看对手还有没有小主可垫（我第一版就错在这里）'],
  [F, 'const CLEARING_MAX_LOW_OUTSTANDING = 1;', 'const CLEARING_MAX_LOW_OUTSTANDING = 5;',
      '「还允许剩几张小主」放宽到 5'],
  [F, 'const CLEARING_MAX_TOP_OUTSTANDING = 2;', 'const CLEARING_MAX_TOP_OUTSTANDING = 6;',
      '「顶端只剩一两张」的门槛放宽到 6'],
  [F, 'if (tier.mine > 0 && topOutstanding === null) topOutstanding = threats;',
      'if (tier.mine > 0 && topOutstanding === null) topOutstanding = 0;',
      'topOutstanding 恒为 0（顶端永远算「已清空」）'],
  [F, `  const drawable = trumps.filter(
    card => !(card.rank === ctx.rankCard && card.suit === ctx.trumpSuit)
  );`, '  const drawable = trumps;', '吊主又去挑主级牌（Glen 的「主7」）'],
  [F, 'if (tier.mine > 0 && threats < mineAtOrAbove)', 'if (tier.mine > 0 && threats === 0)',
      '保底判定退回「独占顶档」（丢掉张数对比）'],
  [F, 'if (tier.mine > 0 && threats < mineAtOrAbove)', 'if (tier.mine > 0 && threats <= mineAtOrAbove)',
      '保底判定把「刚好换得完」也当成保底'],
  [F, `    threats += tier.total - tier.played - tier.mine; // 别人手上或底牌里
    if (tier.mine > 0 && topOutstanding === null) topOutstanding = threats;
    if (tier.mine > 0 && threats < mineAtOrAbove) { holdsTopTrump = true; break; }`,
      `    if (tier.mine > 0 && topOutstanding === null) topOutstanding = threats;
    if (tier.mine > 0 && threats < mineAtOrAbove) { holdsTopTrump = true; break; }
    threats += tier.total - tier.played - tier.mine;`,
      '同档的威胁先判后加（等于不把同强度算成威胁）'],
  [F, 'holdsTopTrump && myTrumps.length >= BOTTOM_MIN_TRUMPS', 'holdsTopTrump', '保底判定不看主牌长度'],
  [F, 'const BOTTOM_MIN_TRUMPS = 9;', 'const BOTTOM_MIN_TRUMPS = 3;', '保底的主牌长度门槛降到 3'],
  [F, 'cost += buriedHere.filter(card => card.rank === 14).length * 300;', '', '埋副 A 不再受罚'],
  [F, 'if (unseen >= 1 && strongPieceSuit(view, ctx, suit, tuning)) {', 'if (unseen >= 2) {',
      '求件回到不看自己有没有件、也不看这门强不强'],
  [F, 'if (!stillHasSuit) continue;', '', '断门也照罚「件被埋光」（会让该断的门不敢断）'],
]);
