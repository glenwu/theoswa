
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, 'if (partnerProbe && donatedPieces > 0) {', 'if (false && donatedPieces > 0) {', '拿掉「队友求件时贡献件」'],
  [F, "if (unseenPieces <= 1) bonus += 320;", 'if (unseenPieces <= 1) bonus += 0;', '未现件只剩一件时不再额外加分'],
  [F, 'score += bonus * settings.inference * tuning.conventionPriorWeight;', 'score += bonus * tuning.conventionPriorWeight;', 'easy 电脑也会求件应答'],
  [F, 'lead.seat === partnerSeatOf(you.seat) && isPieceRequestLead(lead.cards, ctx)', 'lead.seat !== partnerSeatOf(you.seat) && isPieceRequestLead(lead.cards, ctx)', '把对手求件当成队友求件'],
  [F, 'cards.every(card => card.rank <= 5 || card.rank === 10)', 'cards.every(card => true)', '领任何牌都算求件信号'],
  [F, 'if (totalPoints > 0 && afterTeamWinning) penalty *= 0.45;', '', '有分也死护着件不吃'],
  [F, "    const pointTrump = hasBigJoker\n      ? [...trumps.filter(card => cardPoints(card) > 0)]", "    const pointTrump = false\n      ? [...trumps.filter(card => cardPoints(card) > 0)]", '庄家首轮不再带分吊主'],
  [F, '.sort((a, b) => cardStrength(a, ctx) - cardStrength(b, ctx))[0]', '.sort((a, b) => cardStrength(b, ctx) - cardStrength(a, ctx))[0]', '发信号用最大的带分主牌'],
  [F, '!(hasBigJoker && declarerTrumpPointSignal(view, ctx)) ? 480 : 0)', '480)', '收到带分信号也照跟不误'],
  [F, 'return cards.length > 0 && cards.some(card => cardPoints(card) > 0);', 'return cards.length > 0;', '不带分的吊主也当成信号'],
]);
