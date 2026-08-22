// 变异测试：跟牌时早早交出鬼的代价。
import { runMutants } from './mutate.mjs';
const F = 'server/bot-policy.js';
runMutants([
  [F, '  if (early && jokersSpent.length > 0) {', '  if (false) {', '拿掉早盘出鬼的代价（回到实战踩到的 bug）'],
  [F, 'cost * 2.2 - totalPoints * 8', 'cost * 1.0 - totalPoints * 8', '系数降回 1.0（抢牌权加分压得过它）'],
  [F, 'cost * 2.2 - totalPoints * 8', 'cost * 2.2 - totalPoints * 80', '桌上一点分就免罚'],
  [F, 'cost * 2.2 - totalPoints * 8', 'cost * 2.2', '完全不看桌上有多少分（鬼永远不出）'],
  [F, "const jokersSpent = cards.filter(card => card.rank === 15 || card.rank === 16);",
      "const jokersSpent = cards.filter(card => card.rank === 16);", '只保护大鬼，小鬼不管'],
  [F, '  if (early && jokersSpent.length > 0) {', '  if (jokersSpent.length > 0) {', '尾盘也照罚（该出手时出不了手）'],
]);
