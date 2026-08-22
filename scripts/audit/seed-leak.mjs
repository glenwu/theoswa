// 审计 1.2 / 1.6：/api/health 无鉴权返回 state.seed，而 seed 完全决定牌堆顺序。
// 结论若成立：递归牌形扫描器再严密也没用 —— 攻击者不需要看 payload，
// 拿到 seed 自己在本地把整副牌重算一遍即可。
import { createInitialState } from '../../server/state.js';
import { mulberry32 } from '../../server/rng.js';
import { beginRound } from '../../server/round.js';
import { cardLabel } from '../../server/cards.js';

function deckFromSeed(seed) {
  const s = createInitialState(mulberry32(seed));
  s.seed = seed;
  s.declarerSeat = 0;              // 第二局起：先分底牌，牌堆 100 张
  s.teamLevels = [2, 2];
  const r = beginRound(s);
  return { deck: r.deck.map(cardLabel), kitty: r.kitty.map(cardLabel) };
}

const SEED = Number(process.argv[2] ?? 1449984983);
const a = deckFromSeed(SEED);
const b = deckFromSeed(SEED);
const c = deckFromSeed(SEED + 1);

const same = JSON.stringify(a) === JSON.stringify(b);
const diff = JSON.stringify(a) !== JSON.stringify(c);

console.log(`SEED=${SEED}`);
console.log(`同一 seed 两次独立重算，牌堆完全一致：${same ? '是 ✅（可复现）' : '否'}`);
console.log(`换一个 seed 结果不同：${diff ? '是 ✅（确实由 seed 决定）' : '否'}`);
console.log(`\n底牌 8 张（本应只有庄家知道）：\n  ${a.kitty.join(' ')}`);
// 揭牌是从牌堆尾部 pop、逆时针轮转，起揭人公开可知 → 每个座位拿到哪 25 张可直接推出
const starter = 0;
const hands = [[], [], [], []];
const deck = [...a.deck];
let seat = starter;
while (deck.length) {
  hands[seat].push(deck.pop());
  seat = (seat + 1) % 4;          // 逆时针轮转（rotation.nextSeat）
}
console.log(`\n假定起揭人=座位${starter}（公开信息），推出的四家手牌：`);
hands.forEach((h, i) => console.log(`  座位${i} (${h.length} 张): ${h.join(' ')}`));
