// 变异测试：Glen 2026-08-29 的两条裁定 ——
//   ① 对手甩得动时，压他的长度要压过「帮队友求件」；甩不动则维持原判。
//   ② 「可以甩的门」一律不许一张张领，不只是 safeSideThrow 挑中的那一门。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- ① 分档必须真的分两档 ----
  [F, '      (throwReady ? 580 : owed ? 400 : 250) * tuning.leadStrategyPriorWeight,',
      '      (owed ? 400 : 250) * tuning.leadStrategyPriorWeight,',
      '退回老写法：不分档，永远 400 —— 他甩得动时该压却去帮队友'],
  [F, '      (throwReady ? 580 : owed ? 400 : 250) * tuning.leadStrategyPriorWeight,',
      '      (owed ? 580 : 250) * tuning.leadStrategyPriorWeight,',
      '不看甩不甩得动，喂过件就一律 580 —— 他甩不动时也抢了队友的位置'],
  [F, '      (throwReady ? 580 : owed ? 400 : 250) * tuning.leadStrategyPriorWeight,',
      '      (throwReady ? 550 : owed ? 400 : 250) * tuning.leadStrategyPriorWeight,',
      '压到 550 —— 低于帮队友求件的上限 560，等于这条裁定没生效'],

  // ---- ①「甩得动」的判据：我手上的件确实挡得住他 ----
  [F, '  if (items.some(item => item.status === \'mine\')) return false;',
      '  if (items.some(item => item.status === \'seen\')) return false;',
      '把「我手上还有件」看成「件已现身」—— 判反了'],
  [F, '  if (items.some(item => item.status === \'mine\')) return false;',
      '  if (false) return false;',
      '不管我手上有没有件都算他甩得动'],
  [F, '  return maxOpponentSuitEstimate(view, ctx, suit) >= 2;',
      '  return true;',
      '不看他还剩几张 —— 剩一张也当成甩牌威胁'],

  // ---- ② 护的是所有甩得出去的门 ----
  [F, '    cardsOfSuit(hand, suit, ctx).length >= 2 &&\n    canThrowByStatus(view.round?.piecesView?.[suit])',
      '    cardsOfSuit(hand, suit, ctx).length >= 4 &&\n    canThrowByStatus(view.round?.piecesView?.[suit])',
      '退回 safeSideThrow 的早盘门槛：两三张的甩牌门又开始一张张漏'],
  [F, '    cardsOfSuit(hand, suit, ctx).length >= 2 &&\n    canThrowByStatus(view.round?.piecesView?.[suit])',
      '    cardsOfSuit(hand, suit, ctx).length >= 2 &&\n    !canThrowByStatus(view.round?.piecesView?.[suit])',
      '护成了「甩不出去的门」—— 判反'],
  [F, '      proposal.cards.length === 1 && throwSuits.has(suitOf(proposal.cards[0], ctx))',
      '      proposal.cards.length > 1 && throwSuits.has(suitOf(proposal.cards[0], ctx))',
      '改成删多张提案 —— 把甩牌本身删了，单张照漏'],
]);
