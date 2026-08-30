// 变异测试：Glen 2026-08-30「主家不一定是庄家」——
//   「主家一般来说就是需要有明确可行保底/撬底策略……有时候主家不一定是庄家，
//     通常庄家有 8 个底，是最有可能做主家的，但也有可能没 8 张底的人也有好牌。」
// 「有明确可行的策略」对上 roundStrategy 不是 points-first；闲家那边是 grab-bottom。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 闲家里「自己是主家」那一档 ----
  [F, "      : strategy === 'grab-bottom' ? 520",
      '      : 0 ? 520',
      '闲家一律不吊主 —— 走撬底的那手也不吊（退回旧写法）'],
  [F, "      : strategy === 'grab-bottom' ? 520",
      '      : true ? 520',
      '所有闲家都按主家吊主（没有撬底策略的也吊，等于白削自己）'],

  // ---- 那道互相咬住的门 ----
  [F, "  const bottomDone = control.guaranteed && strategy !== 'grab-bottom';",
      '  const bottomDone = control.guaranteed;',
      '撬底那手也被「够保底就别吊了」挡死 —— 上面那档加分永远够不着'],
  [F, "  const bottomDone = control.guaranteed && strategy !== 'grab-bottom';",
      '  const bottomDone = false;',
      '「够保底就去跑副牌」整条没了 —— 庄家保住底也接着死吊'],
]);
