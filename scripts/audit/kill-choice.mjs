// Glen 实战：中后段用主牌毙对手两张的甩牌时，电脑把【两只大鬼】一起交了出去。
// 判牌只看最大那一张（server/trick.js 的 maxStrength），所以一鬼一小主就够。
// 这个脚本把候选和评分全打出来，先弄清是「候选里压根没有一鬼一小」还是「评分选错」。
import { evaluateFollowChoices } from '../../server/bot-policy.js';

const T = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
const label = c => (c.rank === 16 ? '大鬼' : c.rank === 15 ? '小鬼' : `${c.suit}${c.rank}`);

function view({ hand, currentTrick, seat = 2, declarerSeat = 0, handCount = 12 }) {
  return {
    phase: 'PLAYING', declarerSeat,
    you: { seat, team: seat % 2, hand, crossRiver: {} },
    players: [0, 1, 2, 3].map(s => ({ seat: s, team: s % 2, handCount })),
    round: {
      trumpSuit: 'H', rankCard: 2, kittyCount: 8, currentTrick, trickHistory: [],
      piecesView: { S: [], D: [], C: [] },
    },
    botDifficulty: 'expert', botBeliefs: { players: {} },
  };
}

// 对手（座位 3）甩两张黑桃；我（座位 2）黑桃已断，手上主牌很多，含两只大鬼
// 中后段：手牌 8 张（early 的门槛是 > 8，所以这已经不算早盘），主牌仍然很多
const hand = [
  T('JOKER', 16, 0), T('JOKER', 16, 1), T('JOKER', 15, 2),
  ...[14, 13, 4, 3].map((r, i) => T('H', r, i + 10)),
  T('D', 7, 30),
];
// 逆时针 0 → 3 → 2 → 1。座位 1 领牌时顺序是 1 → 0 → 3 → 2，我（座位 2）最后一个出。
const cases = [
  ['没人先毙（我第二个出）', [
    { seat: 3, playSuit: 'S', cards: [T('S', 14, 90), T('S', 13, 91)] },
  ], 2],
  ['对手已经毙过、桌上有 30 分（我最后一个出）', [
    { seat: 1, playSuit: 'S', cards: [T('S', 13, 90), T('S', 10, 91)] },  // 甩两张，20 分
    { seat: 0, cards: [T('C', 4, 92), T('C', 3, 93)] },
    { seat: 3, cards: [T('H', 13, 94), T('H', 11, 95)] },   // 对手用 ♥K 毙了，再添 10 分
  ], 2],
];

for (const [tag, trick, seat] of cases) {
  const choices = evaluateFollowChoices(view({ hand, currentTrick: trick, seat }));
  console.log(`\n=== ${tag} ===`);
  console.log(`候选 ${choices.length} 组，按分数排序：`);
  for (const c of choices.slice(0, 8)) {
    console.log(`  ${String(Math.round(c.score)).padStart(6)}  ${c.cards.map(label).join(' + ')}`);
  }
  const mixed = choices.find(c =>
    c.cards.some(x => x.rank === 16) && c.cards.some(x => x.rank < 15));
  console.log(mixed
    ? `  一鬼+一小主 这组【在】候选里：${mixed.cards.map(label).join(' + ')}  分数 ${Math.round(mixed.score)}`
    : '  ⚠️ 候选里【根本没有】「一鬼 + 一张小主」这种组合');
}
