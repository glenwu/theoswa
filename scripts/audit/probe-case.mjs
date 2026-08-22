import { chooseLeadCards } from '../../server/bot-policy.js';
const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
const view = {
  phase: 'PLAYING',
  declarerSeat: 1,                       // 对手做庄，我是闲家
  you: {
    seat: 0, team: 0,
    hand: [
      ...[12, 11, 10, 9, 8, 7, 6].map((r, i) => C('S', r, i)),  // 黑桃 7 张，一件都没有
      ...[14, 10, 9, 8, 7, 6].map((r, i) => C('D', r, i)),      // 方块 6 张，握着 ♦A
      ...[16, 5, 4].map((r, i) => C('H', r, i)),                // 3 张主
    ],
  },
  players: [
    { seat: 0, team: 0, handCount: 16 }, { seat: 1, team: 1, handCount: 16 },
    { seat: 2, team: 0, handCount: 16 }, { seat: 3, team: 1, handCount: 16 },
  ],
  round: {
    trumpSuit: 'H', rankCard: 2, kittyCount: 8,
    currentTrick: [], trickHistory: [{ trickNo: 1, leadSeat: 1, leadSuit: 'H', plays: [], winnerSeat: 1, points: 0 }],
    piecesView: {
      S: [{ rank: 14, status: 'unseen' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' }],   // 黑桃 4 件全在别人手上
      D: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'seen' }],     // 方块我有 ♦A
      C: [],
    },
  },
  botDifficulty: 'expert',
  botBeliefs: { players: {} },
};
const cards = chooseLeadCards(view);
const c = cards[0];
const suitName = { S: '黑桃(我无件·最弱)', D: '方块(我握♦A)', H: '主牌' }[c.suit];
console.log(`  领出: ${c.suit}${c.rank}  → ${suitName}`);
