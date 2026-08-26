// 变异测试：Glen 这一轮的三条实战反馈 + 「第三家 10 分要不要打 A 封」的裁定。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- ②垫牌里不许夹鬼：赢不了的位置不生成「挑最大的几张」----
  [F, '    for (const fill of discards(rest, count - leadSuitCards.length)) {',
      '    for (const fill of selections(rest, count - leadSuitCards.length)) {',
      '凑张数又回到「全大/全小/全分」三种形状（挑大的那组就是白扔）'],
  [F, '    sets.push(...discards(hand, count));', '    sets.push(...selections(hand, count));',
      '缺门整手垫牌时也挑最大的几张'],
  [F, '      cheapest,\n      pointCards(cards, n, ctx), // 队友已经赢下这一墩时把分送过去',
      '      cheapest,\n      highCards(cards, n, ctx),\n      pointCards(cards, n, ctx), // 队友已经赢下这一墩时把分送过去',
      '垫牌形状里又加回 highCards'],

  // ---- ①求件是一次性的表态 ----
  [F, '    if (isPieceRequestLead(trick.plays?.[0]?.cards ?? [], ctx)) return true;',
      '    if (isPieceRequestLead(trick.plays?.[0]?.cards ?? [], ctx)) return false;',
      '「我方在这门求过没有」永远答否 —— 求件信号不再过期'],
  [F, '    !teamAskedPieceBefore(view, ctx, lead.playSuit, you.team);',
      '    true;', '跟牌的贡献加分不看我方求过没有'],
  [F, '    !teamAskedPieceBefore(view, ctx, lead.playSuit, view.you.seat % 2);',
      '    true;', '第三家的约定贡献不看我方求过没有'],
  [F, '    isPieceAskLead(lead.cards, ctx) &&\n    !teamAskedPieceBefore(view, ctx, lead.playSuit, view.you.seat % 2);',
      '    cardPoints(leadCard) > 0 || !isSidePiece(leadCard, ctx);',
      '回到旧口径：队友单张领这门、只要不是副 A 就算求件'],
  [F, "      !teamAskedPieceBefore(view, ctx, suit, view.you.seat % 2, lastIndex),",
      '      true,', '「回队友这门」的求件加成不看我方求过没有'],

  // ---- ③毙牌阶梯 + 「外面没有更大的主牌了」----
  [F, '    if (suitOf(card, ctx) !== \'TRUMP\') return false; // 不是满手主牌，谈不上压不压',
      '    if (suitOf(card, ctx) !== \'TRUMP\') return true; // 不是满手主牌，谈不上压不压',
      '不是满额主牌也当成「压不倒」'],
  [F, '    after?.seat === you.seat && unbeatableTrumpPlay(view, ctx, cards);',
      '    after?.seat === you.seat && false;',
      '外面没有更大主牌时也照罚分牌暴露（宁可多交一只鬼）'],
  [F, '    if (strength > mine) above += total;', '    if (strength >= mine) above += total;',
      '同强度也算威胁（同点后出者本来就不大）'],

  // ---- 第三家 10 分要不要打 A 封（Glen 的第 2 种情况）----
  [F, '  score -= (coverNeedsFirstPiece(view, ctx) ? 0 : lastSeatPointRisk) *',
      '  score -= (false ? 0 : lastSeatPointRisk) *',
      '这门一支件没现过也照样为了封分把第一支件亮出去'],
  [F, '  if (items.some(item => item.status === \'seen\')) return false;    // 已经有人开过头了',
      '', '已经有人开过头了也还当成「我在开第一支」'],
  [F, '  if (suitPointsAtLarge(view, ctx, lead.playSuit) <= PIECE_COVER_MIN_POINTS) return false;',
      '', '这门早就没分可刮了还死护件（打 10 / 打 K 那条例外没了）'],
  [F, "    suitAskSignal(view, ctx, lead.playSuit) === 'partner' &&\n    forcesPiecesOut(view, ctx, lead.playSuit, covers)",
      '    false',
      '件在对家、又逼得动件的例外没了 —— 一律不杀'],
  [F, "    suitAskSignal(view, ctx, lead.playSuit) === 'partner' &&\n    forcesPiecesOut(view, ctx, lead.playSuit, covers)",
      '    forcesPiecesOut(view, ctx, lead.playSuit, covers)',
      '不看件在不在对家，逼得动就杀'],
  [F, '  if (rest.length < PIECE_FORCE_MIN_LEFT) return false;', '',
      '这门只剩一张也算「逼出来之后我可以大」'],
]);
