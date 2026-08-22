// 随机采样真实发牌，统计「庄家自动埋底把副 A 压进底牌」的频率。
import { chooseKittyCards } from '../../server/bot-policy.js';
import { buildDeck, playSuitOf } from '../../server/cards.js';
import { mulberry32 } from '../../server/rng.js';

const N = Number(process.argv[2] ?? 400);
let buriedAceHands = 0, buriedAces = 0, buriedKings = 0, voided = 0;

for (let i = 0; i < N; i++) {
  const rng = mulberry32(1000 + i);
  const deck = buildDeck();
  for (let j = deck.length - 1; j > 0; j--) {           // Fisher–Yates
    const k = Math.floor(rng() * (j + 1));
    [deck[j], deck[k]] = [deck[k], deck[j]];
  }
  const trumpSuit = ['S', 'H', 'D', 'C'][i % 4];
  const rankCard = 2;
  const ctx = { trumpSuit, rankCard };
  const hand = deck.slice(0, 33);
  const buried = chooseKittyCards(hand, ctx);
  const isSideAce = c => c.suit !== 'JOKER' && c.suit !== trumpSuit && c.rank === 14 && c.rank !== rankCard;
  const isSideKing = c => c.suit !== 'JOKER' && c.suit !== trumpSuit && c.rank === 13 && c.rank !== rankCard;
  const aces = buried.filter(isSideAce).length;
  if (aces > 0) buriedAceHands++;
  buriedAces += aces;
  buriedKings += buried.filter(isSideKing).length;
  const retained = hand.filter(c => !buried.some(b => b.id === c.id));
  for (const s of ['S', 'H', 'D', 'C']) {
    if (s === trumpSuit) continue;
    const before = hand.filter(c => playSuitOf(c, trumpSuit, rankCard) === s).length;
    const after = retained.filter(c => playSuitOf(c, trumpSuit, rankCard) === s).length;
    if (before > 0 && after === 0) voided++;
  }
}
console.log(`  ${N} 手随机庄家牌：`);
console.log(`    压到副 A 的局数   ${buriedAceHands} (${(buriedAceHands / N * 100).toFixed(1)}%)，共 ${buriedAces} 张`);
console.log(`    压到副 K 的张数   ${buriedKings}`);
console.log(`    断门总数          ${voided}`);
