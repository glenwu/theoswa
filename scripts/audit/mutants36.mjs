// 变异测试：Glen 2026-09-06「BOT 把鬼吊完，但剩最后一支是副牌给我们保底……
//   大牌主还是需要留到最后撬底」——最后一张主要留给最后一墩。
// 规矩落成两半：吊主那条提案自己让位，别的意图统一删提案。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 兜住所有意图的那一半（删提案）----
  [F, '  if (!opening && trumps.length === 1 && nonTrumps.length > 0) {',
      '  if (false) {',
      '整条删掉 —— 手上还有副牌也照样把最后一张主领出去'],
  // ⚠️ 「不看手上还有没有副牌」那条变异体【删了 —— 钉不住，也不该钉】：
  // 手上一张副牌都没有时，所有提案本来就全是主牌提案，下面那句
  // `victims.length < proposals.size` 的兜底会整条放行 —— 两种写法行为一样。
  // 代码里那半个条件是【写给人看的】（一句话说清这条规矩管的是哪种局面），
  // 不是靠它挡住什么。行为由「手上一张副牌都没有 → 照领主牌」那条测试钉着。
  [F, `      proposal.cards.every(card => suitOf(card, ctx) === 'TRUMP') &&
      !proposal.reasons.includes('cash-certain-control')`,
      `      proposal.cards.every(card => suitOf(card, ctx) === 'TRUMP')`,
      '连 cash-certain-control 一起删（Glen 亲自裁过的兑现大鬼那一手）'],

  // ---- 吊主那一半（让位，顺带关掉 drawWarranted）----
  [F, '    const spendsLastTrump = trumps.length === 1 && nonTrumps.length > 0;\n    drawWarranted = drawBonus > 0 && !spendsLastTrump;',
      '    const spendsLastTrump = trumps.length === 1 && nonTrumps.length > 0;\n    drawWarranted = drawBonus > 0;',
      '吊主照提，只靠下面那道闸兜（发展长副牌被白白让掉一次）'],
]);
