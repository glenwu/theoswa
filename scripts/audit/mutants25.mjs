// 变异测试：Glen 第四次提的「第三手封门」——
// 前两家都不到 10 就用非件的大牌压住，别让第四家用 10 收走。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 兜底那条不能再把封门整段截住 ----
  [F, '  if (partnerControlSecure || lastKnownVoid) {',
      '  if (!asksForPiece) {',
      '退回老写法：朋友领的不是求件牌就一律出最便宜的（封门整段够不着）'],
  [F, '  if (partnerControlSecure || lastKnownVoid) {',
      '  if (lastKnownVoid) {',
      '朋友已经封住这门也照样去封（白浪费一张大牌）'],
  [F, '  if (partnerControlSecure || lastKnownVoid) {',
      '  if (partnerControlSecure) {',
      '最后一家已知断门也硬去封（他要毙就毙，压多大都没用）'],

  // ---- 封门不许动件 ----
  [F, '    choice => choice.pointValue === 0 && !isSidePiece(choice.cards[0], ctx)',
      '    choice => choice.pointValue === 0',
      '封门时把件也算进候选 —— 副 A 是 0 分，降序排第一个就是它'],

  // ---- 「尽量吃大」 ----
  [F, '      cardStrength(b.cards[0], ctx) - cardStrength(a.cards[0], ctx) ||\n      a.preserveCost - b.preserveCost\n    )[0];\n  }\n  // 无分的非件牌一张都没有',
      '      cardStrength(a.cards[0], ctx) - cardStrength(b.cards[0], ctx) ||\n      a.preserveCost - b.preserveCost\n    )[0];\n  }\n  // 无分的非件牌一张都没有',
      '封门改成挑最小的（等于没封）'],
  // 「先筛出能拿下这一墩的那些」那一层已经删掉了 —— 推得出它恒等
  //（最大的那张要么自己就在那一组里、要么那一组是空的），
  // 变异测试也证实了：删掉它一条测试都不红。理由写在源码里。
]);
