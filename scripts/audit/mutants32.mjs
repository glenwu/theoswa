// 变异测试：Glen 2026-08-30「用自己的件去碰对手的件」。
//   「如果求那门牌已经出到没剩几张，外边还有 8 张 10 张左右的样子，如果被求的对手
//     赔分，5 分 10 分等，这个时候可以用自己手里的件去碰他的件……
//     比如自己有 A，可以用 A 去把 K 碰出来。」
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 整条打法 ----
  [F, `    if (
      mine >= 1 && unseen >= 1 &&
      outstandingInSuit(view, ctx, suit) <= PIECE_BUMP_MAX_OUTSTANDING &&
      opponentDumpedPointsIn(view, ctx, suit)
    ) {`,
      '    if (false) {',
      '整条「用件碰件」删掉'],

  // ---- 两个前提 ----
  [F, '      outstandingInSuit(view, ctx, suit) <= PIECE_BUMP_MAX_OUTSTANDING &&',
      '',
      '不看这门外面还剩几张 —— 满门时他垫一张就躲过去了'],
  [F, '      opponentDumpedPointsIn(view, ctx, suit)',
      '      true',
      '不看他赔没赔分 —— 没凭据就把件送出去'],
  [F, 'const PIECE_BUMP_MAX_OUTSTANDING = 10;', 'const PIECE_BUMP_MAX_OUTSTANDING = 24;',
      '张数门槛放到满门（等于这个前提失效）'],

  // ---- 「赔分」的判据 ----
  [F, '      if (play.seat % 2 === winnerTeam) continue;      // 他那方赢下了，那不叫赔分',
      '',
      '他那方赢下了也算赔分（那是送分给队友，不是赔分）'],
  [F, '      if (play.seat % 2 === view.you.team) continue;   // 只看对手',
      '',
      '我方自己赔的分也算成对手赔分'],

  // ---- 碰的是件本身，不是小牌 ----
  [F, '      const piece = cards.find(card => isSidePiece(card, ctx));',
      '      const piece = lowestLead(cards, ctx);',
      '拿最小的牌去碰（碰件就是要用件去撞，小牌撞不出东西）'],

  // ---- 同意图让位：碰件成立时不再提「压他的长度」 ----
  [F, '  if (threatSuit && threatSuit !== seekingPieceSuit) {',
      '  if (threatSuit) {',
      '两条同时提 —— 压长度叠上发展长门会把知道打哪张的那条盖掉'],
]);
