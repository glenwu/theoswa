
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, "? highCards(trumps, 1, ctx)[0]   // 强势：吊 2 / 吊鬼，求连续吊主\n    : lowestLead(trumps, ctx);       // 弱势：吊小牌，逼对手用大牌来杀",
      "? lowestLead(trumps, ctx)\n    : highCards(trumps, 1, ctx)[0];", '吊主强弱反过来（强吊小、弱吊大）'],
  [F, 'return canSustainTrumpDraw(trumps, ctx, control)', 'return false && canSustainTrumpDraw(trumps, ctx, control)', '一律当弱势主吊小牌'],
  [F, 'return canSustainTrumpDraw(trumps, ctx, control)', 'return true ||  canSustainTrumpDraw(trumps, ctx, control)', '一律当强势主吊大牌'],
  [F, 'card => card.rank === missingRank && card.rank !== ctx.rankCard', 'card => card.rank === 13 && card.rank !== ctx.rankCard', '三件求件回到写死打 K'],
  [F, 'options.push({ card: probe, score: 300 + cards.length });', 'options.push({ card: probe, score: 100 + cards.length });', '三件规则分数被通用探件盖过'],
  [F, "if (!last || last.leadSuit === 'TRUMP') return null;", 'if (!last) return null;', '队友改吊主了还回他副牌'],
  [F, '  const last = leads[leads.length - 1];\n  if (!last || last.leadSuit', '  const last = leads[0];\n  if (!last || last.leadSuit', '只认队友第一次领牌（信号不过期）'],
  [F, 'const request = continuationPiece ? null : partnerRequest(view, ctx);', 'const request = partnerRequest(view, ctx);', '续件时仍提「回队友门」，把续件盖掉'],
]);
