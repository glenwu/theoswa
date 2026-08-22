// 变异测试：优势牌（鬼）不许一开局就打光。
import { runMutants } from './mutate.mjs';
const F = 'server/bot-policy.js';
runMutants([
  [F, 'const withoutJokers = trumps.filter(card => card.rank !== 15 && card.rank !== 16);\n  return highCards(withoutJokers.length ? withoutJokers : trumps, 1, ctx)[0];',
      'return highCards(trumps, 1, ctx)[0];', '强势吊主又拿鬼去吊（回到实战踩到的 bug）'],
  [F, 'card.rank !== 15 && card.rank !== 16', 'card.rank !== 16', '只挡大鬼，小鬼照领'],
  [F, "card.rank !== 15 && card.rank !== 16", "card.suit !== 'JOKER'", '按 suit 认鬼（与全仓的 rank 判断不一致）'],
  [F, '        const wasted = cards.reduce((best, card) => Math.max(best, keepValue(card, ctx)), 0);\n        const protectingPoints = totalPoints > 0 && !lastToAct;\n        score -= (15 + wasted * (protectingPoints ? 0.15 : 1.2)) *\n          settings.controlReserve * controlCaution;',
      '        score -= 15;', '盖过领先的队友只罚 15（回到实战踩到的 bug）'],
  [F, 'const protectingPoints = totalPoints > 0 && !lastToAct;', 'const protectingPoints = true;', '一律当成护分，轻罚'],
  [F, 'const protectingPoints = totalPoints > 0 && !lastToAct;', 'const protectingPoints = false;', '一律当成浪费，重罚'],
  [F, '(protectingPoints ? 0.15 : 1.2)', '(protectingPoints ? 1.2 : 0.15)', '护分与浪费的罚额反过来'],
]);
