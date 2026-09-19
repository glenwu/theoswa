// Glen 2026-09-19：「保底牌及潜在的保底牌（例如有一支大鬼，但小鬼不知道在哪……）
//   不能随便出来吃分，或是到后期随便乱跑掉……我遇到多次在倒数二三轮，BOT 自己把
//   大鬼撞出来，然后给对手保底/撬底。」
//
// 口径：某家打出单张大鬼、打完手上还剩 1~2 张（= 单张墩时的倒数第二 / 第三墩）。
//   · 有得选 = 领牌时手上还有别的牌；跟主时还有别的主；缺门垫/毙时还有别的牌
//   · 另一张大鬼：在我手上 / 这一手之前已经出过 / 下落不明（别家或底里）
//   · 看最后一墩归不归我方（撬底无条件移庄，保底失败就是输）
// ⚠️ 碾压收尾（DOMINANCE）直接清空手牌、不记成墩，那种局还原不出手牌，整局跳过。
//
// 当时（300 局）：跟牌有得选却出大鬼 59 次、最后一墩丢 35；另一张大鬼下落不明的 37 次
// 丢了 29。据此试过「潜在的最后一墩赢牌别交出去」，这个数降到 39 / 21，但【只让一方用】
// 的对抗测里那一方净 −11 级 —— 下落不明的大鬼几乎从不在底里，留着多半白让分，撤了
//（理由详见 bot-policy.js scoreFollow 里那段注释）。领牌侧「只剩大鬼 + 一张副牌不兑现」
// 在同一套对抗测里 3 局全赢、净 +5 级，留下了。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 300);
const BASE = Number(process.env.BASE ?? 4200);
const t = {};
const bump = (k, d = 1) => { t[k] = (t[k] ?? 0) + d; };

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = round?.trickHistory ?? [];
  if (!hist.length) continue;
  if (hist.some(tr => tr.virtual)) { bump('dominance'); continue; }
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const start = new Map(state.players.map(p => [p.seat, [
    ...p.hand, ...hist.flatMap(tr => (tr.plays ?? []).filter(x => x.seat === p.seat).flatMap(x => x.cards)),
  ]]));
  const handAt = (seat, ti) => {
    const gone = new Set();
    for (let k = 0; k < ti; k++)
      for (const p of hist[k].plays ?? []) if (p.seat === seat) for (const c of p.cards ?? []) gone.add(c.id);
    return (start.get(seat) ?? []).filter(c => !gone.has(c.id));
  };
  const seenBefore = (ti, pos) => [
    ...hist.slice(0, ti).flatMap(tr => (tr.plays ?? []).flatMap(p => p.cards)),
    ...(hist[ti].plays ?? []).slice(0, pos).flatMap(p => p.cards),
  ];
  const lastWinTeam = hist[hist.length - 1].winnerSeat % 2;

  hist.forEach((tr, ti) => {
    (tr.plays ?? []).forEach((play, pos) => {
      if (!play.cards.some(c => c.rank === 16)) return;
      const hand = handAt(play.seat, ti);
      const after = hand.length - play.cards.length;
      if (after < 1 || after > 2) return;
      if (play.cards.length !== 1) { bump('multi'); return; }
      const leadSuit = ps(tr.plays[0].cards[0]);
      const joker = play.cards[0];
      let free;
      if (pos === 0) free = hand.length > 1;
      else if (leadSuit === 'TRUMP') free = hand.filter(c => ps(c) === 'TRUMP' && c.id !== joker.id).length > 0;
      else free = hand.some(c => c.id !== joker.id);   // 能出大鬼说明缺门，任何牌都合法
      const otherBig = hand.filter(c => c.rank === 16).length >= 2 ? 'mine'
        : seenBefore(ti, pos).some(c => c.rank === 16) ? 'played' : 'unknown';
      const lost = lastWinTeam !== play.seat % 2 ? 1 : 0;
      const key = `${pos === 0 ? '领' : '跟'}|${free ? '有得选' : '被逼'}`;
      bump(key); bump(`${key}|lost`, lost);
      if (free && pos > 0) { bump(`跟有得选|${otherBig}`); bump(`跟有得选|${otherBig}|lost`, lost); }
    });
  });
}
console.log(`${N} 局 · 打出单张大鬼后手上还剩 1~2 张（倒数二/三墩）  [碾压收尾跳过 ${t.dominance ?? 0} 局，多张 ${t.multi ?? 0} 次]`);
for (const k of ['领|有得选', '领|被逼', '跟|有得选', '跟|被逼'])
  console.log(`  ${k}\t${t[k] ?? 0} 次，最后一墩丢了 ${t[`${k}|lost`] ?? 0}`);
console.log('跟牌有得选时，另一张大鬼：');
for (const o of ['mine', 'played', 'unknown'])
  console.log(`  ${o}\t${t[`跟有得选|${o}`] ?? 0} 次，最后一墩丢了 ${t[`跟有得选|${o}|lost`] ?? 0}`);
