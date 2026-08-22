
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, 'if (!aggressive) return lowestLead(trumps, ctx);', 'if (false) return lowestLead(trumps, ctx);', '一律吊大牌（回到实战踩到的 bug）'],
  [F, 'return highCards(withoutJokers.length ? withoutJokers : trumps, 1, ctx)[0];',
      'return lowestLead(withoutJokers.length ? withoutJokers : trumps, ctx);', '该吊大牌时反而吊小牌'],
  [F, '{ aggressive: planPending }', '{ aggressive: true }', '开局之后一律 aggressive'],
  [F, 'const withoutJokers = trumps.filter(card => card.rank !== 15 && card.rank !== 16);',
      'const withoutJokers = trumps;', '吊大牌时把鬼也算进候选'],
  [F, 'card => card.rank === missingRank && card.rank !== ctx.rankCard', 'card => card.rank === 13 && card.rank !== ctx.rankCard', '三件求件回到写死打 K'],
  [F, 'options.push({ card: probe, score: 300 + cards.length });', 'options.push({ card: probe, score: 100 + cards.length });', '三件规则分数被通用探件盖过'],
  [F, "if (!last || last.leadSuit === 'TRUMP') return null;", 'if (!last) return null;', '队友改吊主了还回他副牌'],
  [F, '  const last = leads[leads.length - 1];\n  if (!last || last.leadSuit', '  const last = leads[0];\n  if (!last || last.leadSuit', '只认队友第一次领牌（信号不过期）'],
  [F, 'const request = continuationPiece ? null : partnerRequest(view, ctx);', 'const request = partnerRequest(view, ctx);', '续件时仍提「回队友门」，把续件盖掉'],
]);
