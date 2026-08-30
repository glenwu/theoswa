// 变异测试：Glen 第 2 条「帮队友把件逼出来」，以及统一后的求件判据。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 求件判据（全项目唯一那一份）----
  [F, '    isPieceRequestLead(cards, ctx) ||\n    (isSidePiece(card, ctx) && cardPoints(card) > 0)',
      '    isPieceRequestLead(cards, ctx)',
      '领副 K 不再算「强烈求 A」'],
  [F, '    isPieceRequestLead(cards, ctx) ||\n    (isSidePiece(card, ctx) && cardPoints(card) > 0)',
      '    !isSidePiece(card, ctx) || cardPoints(card) > 0',
      '退回那个最松的老判据（任何非件小牌都算求件）'],

  // ---- 队友最近一领 = 他现在的计划（换门 / 改吊主就作废）----
  [F, "  if (!last || last.leadSuit === 'TRUMP') return null;",
      '  if (!last) return null;',
      '队友改吊主也当成「回他这门」，跟着去领主牌'],
  [F, '  if (cardsOfSuit(view.you.hand ?? [], suit, ctx).length === 0) return null;',
      '',
      '队友那门我一张都没有了还惦记着去回（lowestLead 拿到空数组）'],

  // ---- 同门跨墩：他换成非求件牌接着打这门，第一次那个求件仍然算数 ----
  // ⚠️ 2026-08-29 之后这一段是靠 firstLeadInSuit 实现的：求件只算这门第一次
  // 被领的那一手，所以「他后来又领这门」自然不影响那次求件仍然算数。
  [F, `    const first = firstLeadInSuit(view, suit);
    if (first && first.seat === partnerSeat && isPieceAskLead(first.cards, ctx)) {
      return { suit, seeking: true, partnerIsDeclarer };
    }`, '',
      '跨墩记忆整段删掉 —— 只认他最近一领是不是求件牌'],
  // ⚠️ 「不看这门第一次是不是队友领的」那一条【删了 —— 杀不掉，也没别处盖住】。
  // 试过两个 fixture 都被别的规矩罩住了（都在 scratchpad/probeF.mjs 里试过）：
  //   · 让队友在第 1 墩交件来关掉「不领对手求的门」→ compress 跟着成立，
  //     它和「回队友那门」走的是同一个 quietLead，580 稳压 480，两种写法同结果；
  //   · 改用长门的甩牌欲望来关掉那条 → quietLead 本来就放行最小牌，
  //     「逼件领最小」和「中性牌」挑到的是同一张。
  // 判据本身没问题（它就是 Glen 那条规矩的直译，suitAskSignal 那一层单独钉着），
  // 只是隔离不出来。留一条永远存活的变异体只会让整套的杀伤率失真。
  [F, "  if (items.some(item => item.status === 'unseen')) {",
      '  if (true) {',
      '件已经全现了还在接着逼（该甩的时候还在一张张领）'],
  [F, '      return { suit, seeking: true, partnerIsDeclarer };',
      '      return { suit, seeking: false, partnerIsDeclarer };',
      '未了的求件不再算「明确求件」，力度掉回普通回门'],
]);
