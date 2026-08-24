// 复核 Glen 的实战反馈①：「一方 BOT 求了个件，对方打出来后又打了个 5 以下，
// 其实这个时候已经不代表求件了，因为之前对家已经求过……我似乎看到他们互出件，
// 然后给我方甩牌。」
//
// 口径全部来自公开的 trickHistory：
//   求件领牌 = 副牌花色、单张、不是件本身、点数 ≤5 或 =10（isPieceRequestLead 同款）
//   贡献     = 领牌者的【对家】在这一墩打出了这门的副 A / 副 K
// 按「这是我方在这门牌上的第几次求件」分档统计。第 2 次及以后的求件按 Glen
// 的裁定根本不成立，那时候还去贡献件，就是白白把「未现」变「已现」。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 400);
const BASE = Number(process.env.BASE ?? 4200);
const ask = [0, 0, 0];      // 第 1 次 / 第 2 次 / 第 3 次及以后
const give = [0, 0, 0];
let throwsAgainst = 0, rounds = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  rounds += 1;
  const { trumpSuit, rankCard } = round;
  const piece = c => c.suit !== 'JOKER' && c.suit !== trumpSuit &&
    (c.rank === 13 || c.rank === 14) && c.rank !== rankCard;
  const askLead = cards => cards.length === 1 && !piece(cards[0]) &&
    (cards[0].rank <= 5 || cards[0].rank === 10);

  const seen = new Map(); // `${team}|${suit}` -> 已经求过几次
  for (const t of hist) {
    const lead = t.plays?.[0];
    if (!lead || t.leadSuit === 'TRUMP') continue;
    if (t.leadType === 'throw') {
      // 这门被甩了，且甩牌方不是先前求件的那一方 —— Glen 说的「给我方甩牌」
      throwsAgainst += 1;
      continue;
    }
    if (!askLead(lead.cards ?? [])) continue;
    const team = t.leadSeat % 2;
    const key = `${team}|${t.leadSuit}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const bucket = Math.min(nth, 2);
    ask[bucket] += 1;
    const partnerSeat = (t.leadSeat + 2) % 4;
    const mate = (t.plays ?? []).find(p => p.seat === partnerSeat);
    const gave = (mate?.cards ?? []).some(c =>
      playSuitOf(c, trumpSuit, rankCard) === t.leadSuit && piece(c));
    if (!gave) continue;
    // ⚠️ 「贡献」里绝大部分其实是【没得选】—— 这门只剩那张 K，跟牌规则逼的。
    // 从公开历史就能分辨：他在【之后的墩】里还打出过这门的非件牌，
    // 说明当时手上有替代品，是自己选的。
    const later = hist.slice(hist.indexOf(t) + 1);
    const hadAlt = later.some(t2 => (t2.plays ?? []).some(p2 =>
      p2.seat === partnerSeat &&
      (p2.cards ?? []).some(c => playSuitOf(c, trumpSuit, rankCard) === t.leadSuit && !piece(c))));
    if (hadAlt) give[bucket] += 1;
  }
}
console.log(`${rounds} 局（BASE=${BASE}）\n`);
console.log('这是我方在这门牌上的第几次求件   求件次数   对家【有得选还是】贡献   比例');
const label = ['第 1 次', '第 2 次', '第 3 次及以后'];
for (let k = 0; k < 3; k++) {
  const pct = ask[k] ? `${(give[k] / ask[k] * 100).toFixed(0)}%` : '—';
  console.log(`${label[k].padEnd(28)}${String(ask[k]).padStart(8)}${String(give[k]).padStart(14)}${pct.padStart(9)}`);
}
console.log(`\n全局甩牌墩数：${throwsAgainst}`);
