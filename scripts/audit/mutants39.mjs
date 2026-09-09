// 变异测试：Glen 2026-09-09 第二条 ——
//   「吊主的时候……如果没有分，而且自己也无所谓别人吊主（即自己不是保底/撬底牌
//     或是没有要求件的副门）就可以放一下，因为 2 和主 2 还是相对比较大的牌，
//     不需要浪费在无分的局。」
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '      score -= 400 * tuning.emptyTrumpPenaltyWeight;',
      '      score -= 0 * tuning.emptyTrumpPenaltyWeight;',
      '整条去掉 —— 末家照旧拿级牌去买无分的吊主墩'],

  [F, '  if (control.holdsTopTrump || control.guaranteed) return false;      // 我就是保底/撬底那手',
      '  if (false) return false;',
      '不看自己是不是保底那手 —— 顶端在手也跟着放'],

  // ⚠️ 另外两个条件【没写变异体 —— 单元 fixture 钉不住，但都用实测证过是活的】：
  //
  // ① `cards.every(card => isRankTrump(card, ctx))`（只罚级牌）：
  //    改成 true（连小主也罚）后，scripts/audit/fourth-hand-rank.mjs 里
  //    「手上有更便宜的主却还是花了级牌」64 → 62 —— 差 2 次。构造的 fixture 里
  //    小主本来就赢不下那一墩（赢不下就进不了 afterTeamWinning 那个分支），
  //    要让小主【恰好】赢、而且罚分是胜负手，那个窗口太窄，试了没做出来。
  //
  // ② `totalPoints === 0`（只管无分墩）：这条是 Glen 原话「如果没有分」的直译，
  //    而且实测很活 —— 去掉之后【有分】的主牌墩里末家用级牌盖下来的
  //    73 次（12.9%）掉到 46 次（8.0%），等于白让掉 27 个带分的墩。
  //    但同一个 fixture 里接管加分（100 + 分×10 + 45）本来就压得过这条罚，
  //    单元里分不开。行为由上面那个对照指标盯着。
]);
