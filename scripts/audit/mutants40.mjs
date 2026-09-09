// 变异测试：Glen 2026-09-09 第三条 ——
//   「如果对手两家都没主牌的情况，经常还会把主牌都打得很光……
//     自己主牌打光，别人甩牌就毙不到了。」
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '      !bottomDone && !opponentsTrumpless && (!strongSide || planPending)) {',
      '      !bottomDone && (!strongSide || planPending)) {',
      '整条去掉 —— 对手两家都没主了还接着吊'],

  [F, '  return opponents.every(player => knownVoidInSuit(view, player.seat, \'TRUMP\', ctx));',
      '  return opponents.some(player => knownVoidInSuit(view, player.seat, \'TRUMP\', ctx));',
      '只要有一家断主就停吊（另一家还有主，吊主明明还在削他）'],
]);
