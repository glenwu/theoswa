
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, 'if (!(isPlanSuit && !plan.ready)) {', 'if (true) {', '计划未到时机也照甩不误（回到「能甩就甩」）'],
  [F, "(isPlanSuit && plan.ready ? 1_100 : 620)", '620', '时机到了也不抬高甩牌优先级'],
  [F, 'if (!control.holdsTopTrump) return null; // 没有起手牌，这个计划无从谈起', '', '没有起手牌也敢做长期计划'],
  [F, 'if (!canThrowByStatus(view.round?.piecesView?.[suit])) continue;', '', '甩牌资格还没成立就开始计划'],
  [F, 'if (cards.length < 3) continue; // 太短甩了没意义', '', '两张也当尾巴'],
  [F, 'ready: worstOpponentTrumps < best.cards.length', 'ready: true', '永远认为时机已到'],
  [F, 'ready: worstOpponentTrumps < best.cards.length', 'ready: false', '永远认为时机未到'],
  [F, 'worst = Math.max(worst, (outstanding * (player.handCount ?? 0)) / hidden);', 'worst = Math.max(worst, outstanding);', '不按手牌数摊分，直接用场上主牌总数'],
  [F, 'if (player.seat % 2 === view.you.team) continue; // 队友的主牌不会来毙我', '', '把队友的主牌也算成威胁'],
  [F, '(!strongSide || planPending)', '(!strongSide)', '计划挂起时也因为副牌强而停止吊主'],
  [F, 'if (spentTail > 0 && lead.playSuit !== tailPlan.suit) {', 'if (false) {', '计划挂起时照样垫掉长门的牌'],
]);
