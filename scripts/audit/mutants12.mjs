// 变异测试：优势牌（鬼）不许一开局就打光。
import { runMutants } from './mutate.mjs';
const F = 'server/bot-policy.js';
runMutants([
  // 「已确认对手全主 → 兑现大鬼」这条只在【大鬼是唯一主牌】时才成立（Glen 实战反馈）
  [F, '    trumps.length === 1 &&\n', '', '手上还有别的主牌也照样把大鬼兑现掉'],
  [F, '    trumps.length === 1 &&', '    trumps.length >= 1 &&', '门槛放宽成「有主牌就行」'],
  [F, 'const drawableTrumps = trumps.filter(card => card.rank !== 15 && card.rank !== 16);',
      'const drawableTrumps = trumps;', '吊主候选里又混进了鬼（回到实战踩到的 bug）'],
  [F, 'card.rank !== 15 && card.rank !== 16', 'card.rank !== 16', '只挡大鬼，小鬼照领'],
  [F, "card.rank !== 15 && card.rank !== 16", "card.suit !== 'JOKER'", '按 suit 认鬼（与全仓的 rank 判断不一致）'],
  [F, '        const wasted = cards.reduce((best, card) => Math.max(best, keepValue(card, ctx)), 0);\n        const protectingPoints = totalPoints > 0 && !lastToAct;\n        score -= (15 + wasted * (protectingPoints ? 0.15 : 1.2)) *\n          settings.controlReserve * controlCaution;',
      '        score -= 15;', '盖过领先的队友只罚 15（回到实战踩到的 bug）'],
  [F, 'const protectingPoints = totalPoints > 0 && !lastToAct;', 'const protectingPoints = true;', '一律当成护分，轻罚'],
  [F, 'const protectingPoints = totalPoints > 0 && !lastToAct;', 'const protectingPoints = false;', '一律当成浪费，重罚'],
  [F, '(protectingPoints ? 0.15 : 1.2)', '(protectingPoints ? 1.2 : 0.15)', '护分与浪费的罚额反过来'],
]);
