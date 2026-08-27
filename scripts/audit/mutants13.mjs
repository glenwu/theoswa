// 变异测试：跟牌时早早交出鬼的代价。
import { runMutants } from './mutate.mjs';
const F = 'server/bot-policy.js';
runMutants([
  [F, '  if (jokersSpent.length > 0) {', '  if (false) {', '拿掉出鬼的代价（回到实战踩到的 bug）'],
  [F, 'cost * 2.2 - totalPoints * 8', 'cost * 1.0 - totalPoints * 8', '系数降回 1.0（抢牌权加分压得过它）'],
  [F, 'cost * 2.2 - totalPoints * 8', 'cost * 2.2 - totalPoints * 80', '桌上一点分就免罚'],
  [F, 'cost * 2.2 - totalPoints * 8', 'cost * 2.2', '完全不看桌上有多少分（鬼永远不出）'],
  [F, "const jokersSpent = cards.filter(card => card.rank === 15 || card.rank === 16);",
      "const jokersSpent = cards.filter(card => card.rank === 16);", '只保护大鬼，小鬼不管'],
  // 「尾盘也照罚」那条撤了 —— Glen 第三次强调之后，尾盘【就是】要照罚
  // （保底/撬底比的就是最后一墩），那个开关本身已经去掉。现在管这件事的是
  // mutants21 的第一条：把 early 装回去会不会被测试抓住。
]);
