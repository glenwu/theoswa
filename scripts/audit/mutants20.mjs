// 变异测试：Glen 的「垫件 vs 垫小主」—— 默认垫件，对手正在甩牌时留住。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 「不动件」那一手候选 ----
  [F, `    const sparing = cheapest.some(card => isSidePiece(card, ctx))
      ? lowCards(cards.filter(card => !isSidePiece(card, ctx)), n, ctx)
      : null;`,
      '    const sparing = null;',
      '不给「宁可动主牌也不动件」这个候选（罚分再重也没得选）'],
  // 试过一条「把 cheapest 换成 sparing ?? cheapest」（= 有得躲就一定躲），
  // 【构造上杀不掉】：followCandidates 末尾的 pickAutoCards 兜底本来就会把
  // 带件的那一手交上来，两种写法产出的决策一模一样。留着 cheapest 是为了
  // 把「默认垫件」写在明处，不去指望那个隐式兜底 —— 不是没测到。

  // ---- 对手正在甩牌这个判据 ----
  [F, 'return !!lead && (lead.cards?.length ?? 1) > 1 && lead.seat % 2 !== view.you.team;',
      'return !!lead && (lead.cards?.length ?? 1) > 1 && lead.seat % 2 === view.you.team;',
      '判反：队友甩牌才当危险，对手甩牌反而放行'],
  [F, 'return !!lead && (lead.cards?.length ?? 1) > 1 && lead.seat % 2 !== view.you.team;',
      'return !!lead && lead.seat % 2 !== view.you.team;',
      '对手领单张也当成在甩牌'],

  // ---- 两个折扣的取消 ----
  [F, `    if (
      !throwing &&
      cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER
    ) return sum;`,
      '    if (cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER) return sum;',
      '对手甩牌时「快断门」照样豁免'],
]);
