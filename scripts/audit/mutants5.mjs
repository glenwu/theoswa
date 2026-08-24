
import { runMutants } from './mutate.mjs';

// 「吊主候选里不含鬼」「不挑主级牌」这两条已经移到 mutants4（和吊主的其它开关放一起）。
const F = 'server/bot-policy.js';
runMutants([
  // ---- 「这门还剩多少分」：即使对方甩了也得不了多少分，就不必死护件（Glen）----
  [F, '    const stake = Math.max(\n      SUIT_POINTS_FLOOR,\n      suitPointsAtLarge(view, ctx, suit) / SIDE_SUIT_MAX_POINTS\n    );',
      '    const stake = 1;', '不看这门还剩多少分'],
  [F, 'const SUIT_POINTS_FLOOR = 0.4;', 'const SUIT_POINTS_FLOOR = 1;',
      '分全走光也照原价罚（下限抬到 1，等于这一维失效）'],
  [F, 'suitPointsAtLarge(view, ctx, suit) / SIDE_SUIT_MAX_POINTS',
      'suitPointsAtLarge(view, ctx, suit) / sideSuitTotalPoints(ctx)',
      '分母用本局该门满分（打10 时 30/30=1，正好把效果除没）'],
  // ---- 读件的位置（Glen：看「打这门牌的欲望」，但不是 100%，所以只缩放不豁免）----
  [F, '    const signal = suitAskSignal(view, ctx, suit);', "    const signal = 'opponent';",
      '不读件的位置，一律按最坏算'],
  [F, 'const PIECE_READ_PARTNER_ASKED = 0.35;', 'const PIECE_READ_PARTNER_ASKED = 1;',
      '对家求过这门也照罚（读了等于没读）'],
  [F, 'const PIECE_READ_NOBODY_ASKED = 0.7;', 'const PIECE_READ_NOBODY_ASKED = 1;',
      '谁都没求过也照罚'],
  [F, '    ...(current ? [{ seat: current.seat, suit: current.playSuit, cards: current.cards ?? [] }] : []),', '',
      '只扫历史墩，看不见对手正在这一墩求件'],
  [F, "  if (partnerAsked) return 'partner';   // 对家在要这门 —— 件多半在他那", '',
      '对家求过也当成没人求'],
  [F, "  if (partnerAsked) return 'partner';   // 对家在要这门 —— 件多半在他那\n  if (opponentAsked) return 'opponent'; // 只有对手在要 —— 风险照旧，别亮",
      "  if (opponentAsked) return 'opponent';\n  if (partnerAsked) return 'partner';",
      '优先级反过来（对手在前，对家那条永远轮不到）'],
  // ---- 亮件的代价（Glen：「对家没表示就别随便出，这是冒险的行为」）----
  [F, '  if (exposureRisk > 0) {', '  if (false) {', '亮件完全没有代价'],
  [F, 'const PIECE_EXPOSURE_COST = 240;', 'const PIECE_EXPOSURE_COST = 40;', '亮件的代价小到可以忽略'],
  [F, '    if (cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER) return sum;',
      '', '不认「这门快断了就可以打」这条豁免'],
  [F, 'const PIECE_NEAR_VOID_AFTER = 2;', 'const PIECE_NEAR_VOID_AFTER = 0;',
      '「快断门」的门槛收到 0（等于这条豁免失效）'],
  // ---- 求件方资格：两件 ≥6 支 / 单件 ≥8 支（Glen 口述的两档门槛）----
  [F, 'const SINGLE_PIECE_MIN_LENGTH = 8;', 'const SINGLE_PIECE_MIN_LENGTH = 6;',
      '单件那一档的长度门槛降回 6（两档合一）'],
  [F, '  if (mine >= 2) return cards.length >= tuning.pieceProbeMinLength;\n  if (mine >= 1) return cards.length >= SINGLE_PIECE_MIN_LENGTH;',
      '  if (mine >= 1) return cards.length >= tuning.pieceProbeMinLength;',
      '不分两档，一件两件同一个门槛'],
  [F, '  if (mine >= 2) return cards.length >= tuning.pieceProbeMinLength;',
      '  if (mine >= 2) return true;', '两件那一档不看牌长'],
  [F, "if (mode === 'low') return lowestLead(trumps, ctx);", 'if (false) return lowestLead(trumps, ctx);', '一律吊大牌（回到实战踩到的 bug）'],
  [F, 'return highCards(drawable.length ? drawable : trumps, 1, ctx)[0];',
      'return lowestLead(drawable.length ? drawable : trumps, ctx);', '该吊大牌时反而吊小牌'],
  [F, "mode: clearing ? 'clearing' : planPending ? 'tier' : 'low',",
      "mode: clearing ? 'clearing' : 'tier',", '开局之后一律吊大牌（不看甩尾手计划挂没挂起）'],
  [F, 'card => card.rank === missingRank && card.rank !== ctx.rankCard', 'card => card.rank === 13 && card.rank !== ctx.rankCard', '三件求件回到写死打 K'],
  [F, 'options.push({ card: probe, score: 300 + cards.length });', 'options.push({ card: probe, score: 100 + cards.length });', '三件规则分数被通用探件盖过'],
  [F, "if (!last || last.leadSuit === 'TRUMP') return null;", 'if (!last) return null;', '队友改吊主了还回他副牌'],
  [F, '  const last = leads[leads.length - 1];\n  if (!last || last.leadSuit', '  const last = leads[0];\n  if (!last || last.leadSuit', '只认队友第一次领牌（信号不过期）'],
  [F, 'const request = continuationPiece ? null : partnerRequest(view, ctx);', 'const request = partnerRequest(view, ctx);', '续件时仍提「回队友门」，把续件盖掉'],
]);
