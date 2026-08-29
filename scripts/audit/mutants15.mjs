// 变异测试：本局策略（Glen「需要有一定的策略支持，然后一直跟随它去打」）。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, "    if (control.holdsTopTrump && trumps.length >= BOTTOM_MIN_TRUMPS) return 'grab-bottom';",
      '', '闲家再强也不撬底，一律吃分'],
  [F, "  if (bottomHopeless(view, ctx, control)) return 'points-first';", '',
      '庄家保底无望时也死保底，不改跑分'],
  [F, "    return trumps.length >= BOTTOM_MIN_TRUMPS ? 'run-side' : 'run-and-score';",
      "    return 'run-side';", '有保底牌就一律跑副牌，不看主长不长'],
  [F, "  const drawFloor = style === 'trump' ? BOTTOM_MIN_TRUMPS - 1 : BOTTOM_MIN_TRUMPS;",
      '  const drawFloor = BOTTOM_MIN_TRUMPS;', '拿掉惯性（少一张主就改弦更张）'],
  [F, "  if (trumps.length >= drawFloor) return 'draw-trumps';", '',
      '没保底牌时主再长也不吊'],
  [F, `    !hasStrongSideSuit(view, ctx) &&
    !control.holdsTopTrump &&
    control.trumpCount < BOTTOM_MIN_TRUMPS`,
      '    !control.holdsTopTrump', '「保底无望」只看顶牌，不看副牌威胁和主牌长度'],
  [F, `    const scale = roundStrategy(view, ctx, bottomControlOf(view, ctx)) === 'points-first'
      ? tuning.pointsFirstPieceWeight
      : 1;`, '    const scale = 1;', '闲家吃分为主这条策略没接到出牌上'],

  // ---- 策略接到领牌上 ----
  [F, `      (160 + (strategy === 'run-side' || strategy === 'run-and-score'
        ? STRATEGY_RUN_SIDE_BONUS : 0)) * tuning.leadStrategyPriorWeight,`,
      '      160 * tuning.leadStrategyPriorWeight,', '「以跑副牌为主」没接到领牌上'],
  // ⚠️ 「已经改跑分为主的庄家还在吊主」那一条【删了】——
  // Glen 2026-08-29 裁定 points-first 不再是停吊的理由：
  //   「主牌只有 7、8 张、又没顶牌、副牌也弱……吊，因为你不知道队友是什么牌，
  //     也不知道对手有多少主，对手也有可能主比你短。」
  // 停吊的判据换成「我的主已经不比对手长」，对应的变异体在 mutants29。
]);
