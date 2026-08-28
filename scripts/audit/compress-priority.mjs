// Glen 裁定（compress-after-giving-piece 的优先级）：
//   「我方刚把 ♠A 喂给对手了，同时队友在求 ♥件 —— 如果判断对手可以甩牌了，
//     应该先去压 ♠ 的长度，因为此时对手甩牌的威胁比你去给队友件要更大，
//     对手可以甩的牌短一支，那就少一份威胁。」
//
// 口径：找出「对手求件、我方交出了件」的墩（记这门为 S），再看我方之后
// 【第一次领牌】领的是不是 S。按【那一刻对手甩不甩得动 S】分两栏：
//   甩得动 = 领牌那一刻我手上再没有 S 的件（挡不住他） + 对手手上还有 ≥2 张 S。
// Glen 要的是【甩得动那一栏】压到高位；甩不动那栏维持原判（400，可以被
// 帮队友求件盖过），所以两栏本来就该有明显落差。
//
// 「那一刻手上有什么」= 该家从这一墩起往后打出的所有牌（牌只会变少，还原是准的）。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);

const box = { ready: { led: 0, else: 0 }, notReady: { led: 0, else: 0 } };
let cases = 0, noCards = 0, neverLed = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;

  // 从第 k 墩起，seat 还打出过哪些牌（= 那一刻手上有的牌）
  const restOf = (k, pred) => {
    const out = [];
    for (let j = k; j < hist.length; j++)
      for (const p of hist[j].plays ?? []) if (pred(p.seat)) out.push(...(p.cards ?? []));
    return out;
  };

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead || t.leadSuit === 'TRUMP') return;
    const a = lead.cards ?? [];
    if (a.length !== 1 || isPiece(a[0]) || !(a[0].rank <= 5 || a[0].rank === 10)) return;
    const suit = t.leadSuit;
    for (const play of (t.plays ?? []).slice(1)) {
      if ((play.seat % 2) === (lead.seat % 2)) continue;   // 只看对手求、我方给
      if (!(play.cards ?? []).some(isPiece)) continue;
      const myTeam = play.seat % 2;
      cases += 1;

      let found = null, idx = -1;
      for (let k = ti + 1; k < hist.length; k++) {
        if ((hist[k].leadSeat % 2) !== myTeam) continue;
        found = hist[k]; idx = k; break;
      }
      if (!found) { neverLed += 1; break; }

      const mineLater = restOf(idx, s => s === found.leadSeat);
      if (!mineLater.some(c => ps(c) === suit)) { noCards += 1; break; }

      // 甩得动？我手上再没这门的件 + 对手还有 ≥2 张
      const iStillHoldPiece = mineLater.some(c => ps(c) === suit && isPiece(c));
      const oppLeft = restOf(idx, s => s % 2 !== myTeam).filter(c => ps(c) === suit).length;
      const ready = !iStillHoldPiece && oppLeft >= 2;

      const bin = ready ? box.ready : box.notReady;
      if (found.leadSuit === suit) bin.led += 1; else bin.else += 1;
      break;
    }
  });
}

const row = (name, bin) => {
  const n = bin.led + bin.else;
  const pct = n ? `${(bin.led * 100 / n).toFixed(1)}%` : '--';
  console.log(`  ${name}\t领这门 ${bin.led}\t领别门 ${bin.else}\t→ ${pct}`);
};
console.log(`${N} 局：「对手求件、我方交出了件」共 ${cases} 次`);
console.log(`  其中这门已打空 ${noCards}，之后再没领过牌 ${neverLed}`);
console.log(`我方之后第一次领牌，领的是不是这门：`);
row('对手甩得动（Glen 要压到高位）', box.ready);
row('对手甩不动（维持 400）      ', box.notReady);
