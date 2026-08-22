import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState } from '../state.js';
import { applyAction, ErrorCode } from '../actions.js';
import { GameEngine } from '../game-engine.js';
import { viewerState } from '../viewer.js';
import { ROUND_DEADLINE_FIELDS, shiftDeadlines } from '../pause.js';

const seeded = () => 0.42;

function playingState() {
  const s = createInitialState(seeded);
  for (const id of ['T', 'H', 'B', 'M']) applyAction(s, { type: 'join' }, id);
  s.phase = 'PLAYING';
  s.declarerSeat = 0;
  s.round = createRoundState(1, 0);
  s.round.trumpSuit = 'S';
  s.round.rankCard = 2;
  s.round.turnSeat = 0;
  s.round.leadSeat = 0;
  return s;
}

// ⚠️ 暂停最容易写错的地方：所有截止时刻都是绝对时间戳。
// 暂停十分钟再恢复，它们全在过去，恢复瞬间会一口气全触发 ——
// 庄家的底自动埋了、出牌自动打了、本局小结直接跳过。
test('恢复时把所有绝对截止时刻整体往后推「暂停了多久」', () => {
  const s = playingState();
  const base = Date.now() + 60_000;
  const r = s.round;
  for (const key of ROUND_DEADLINE_FIELDS) r[key] = base;
  r.crossRiver.decideDeadline = base;
  r.crossRiver.active = [{ fromSeat: 1, toSeat: 3, deadline: base }];
  s.resetProposal = { fromSeat: 0, yesSeats: [], reshuffleSeats: false, deadline: base };

  shiftDeadlines(s, 10 * 60_000);

  for (const key of ROUND_DEADLINE_FIELDS) {
    assert.equal(r[key], base + 600_000, `${key} 没有跟着后移`);
  }
  assert.equal(r.crossRiver.decideDeadline, base + 600_000);
  assert.equal(r.crossRiver.active[0].deadline, base + 600_000);
  assert.equal(s.resetProposal.deadline, base + 600_000, '新开一局提案的倒计时也要停');
});

// 防呆：新加了 *Deadline 字段却忘了登记，暂停就会漏掉它。
test('ROUND_DEADLINE_FIELDS 覆盖 createRoundState 里所有 *Deadline 字段', () => {
  const actual = Object.keys(createRoundState(1, 0)).filter(k => k.endsWith('Deadline')).sort();
  assert.deepEqual(actual, [...ROUND_DEADLINE_FIELDS].sort());
});

test('null 的截止时刻不受影响；负数/非法 delta 直接跳过', () => {
  const s = playingState();
  s.round.playDeadline = null;
  shiftDeadlines(s, 1000);
  assert.equal(s.round.playDeadline, null);
  s.round.playDeadline = 5000;
  shiftDeadlines(s, -1000);
  shiftDeadlines(s, NaN);
  assert.equal(s.round.playDeadline, 5000);
});

// ---- 手动暂停 ----

test('任何人都能暂停；暂停后拒绝一切推进牌局的动作', () => {
  const s = playingState();
  assert.equal(applyAction(s, { type: 'pause' }, 'H').ok, true);
  assert.equal(s.paused.bySeat, s.players.find(p => p.id === 'H').seat);
  assert.equal(s.paused.auto, false);
  assert.match(s.log.map(l => l.text).join('\n'), /暂停了游戏/);

  const play = applyAction(s, { type: 'play', cardIds: ['x'] }, 'T');
  assert.equal(play.ok, false);
  assert.equal(play.error.code, ErrorCode.PAUSED);

  assert.equal(applyAction(s, { type: 'pause' }, 'T').error.code, ErrorCode.PAUSED, '不能重复暂停');
});

test('暂停期间仍可聊天、进出房间（不然掉线的人回不来）', () => {
  const s = playingState();
  applyAction(s, { type: 'pause' }, 'T');
  assert.equal(applyAction(s, { type: 'chat', text: '等我一下' }, 'H').ok, true);
  assert.equal(applyAction(s, { type: 'leave' }, 'H').ok, true);
  assert.equal(applyAction(s, { type: 'join' }, 'H').ok, true);
});

test('恢复：任何真人都可以；电脑不行；没暂停时报 NOT_PAUSED', () => {
  const s = playingState();
  assert.equal(applyAction(s, { type: 'resume' }, 'T').error.code, ErrorCode.NOT_PAUSED);

  applyAction(s, { type: 'pause' }, 'T');
  s.players.find(p => p.id === 'B').isBot = true;
  assert.equal(applyAction(s, { type: 'resume' }, 'B').error.code, ErrorCode.FORBIDDEN, '电脑不能恢复');

  assert.equal(applyAction(s, { type: 'resume' }, 'M').ok, true, '不是暂停发起人也能恢复');
  assert.equal(s.paused, null);
  assert.equal(applyAction(s, { type: 'play', cardIds: ['x'] }, 'T').error.code !== ErrorCode.PAUSED, true);
});

// ---- 自动暂停 ----

test('真人全部离线（只剩电脑）→ 自动暂停', () => {
  const s = playingState();
  for (const id of ['H', 'B', 'M']) s.players.find(p => p.id === id).isBot = true;
  assert.equal(s.paused, null);
  applyAction(s, { type: 'leave' }, 'T');
  assert.notEqual(s.paused, null);
  assert.equal(s.paused.auto, true);
  assert.equal(s.paused.bySeat, null);
  assert.match(s.log.map(l => l.text).join('\n'), /真人玩家已全部离线/);
});

test('还有别的真人在线 → 不自动暂停', () => {
  const s = playingState();
  s.players.find(p => p.id === 'B').isBot = true;
  s.players.find(p => p.id === 'M').isBot = true;
  applyAction(s, { type: 'leave' }, 'T');
  assert.equal(s.paused, null, 'H 还在线');
});

test('开局前 / 游戏结束后不自动暂停（没什么可保护的）', () => {
  for (const phase of ['SEATING', 'GAME_OVER']) {
    const s = playingState();
    s.phase = phase;
    if (phase === 'SEATING') s.round = null;
    for (const id of ['H', 'B', 'M']) s.players.find(p => p.id === id).isBot = true;
    applyAction(s, { type: 'leave' }, 'T');
    assert.equal(s.paused, null, `${phase} 不该自动暂停`);
  }
});

// ---- 引擎与电脑 ----

test('暂停时引擎一个计时器都不排；恢复后重新排上', () => {
  const s = playingState();
  const engine = new GameEngine({ state: s, broadcast: () => {} });
  assert.ok(engine.timers.size > 0, '出牌阶段本来有计时器');

  engine.applyAction({ type: 'pause' }, 'T');
  assert.equal(engine.timers.size, 0, '暂停后清空');

  engine.applyAction({ type: 'resume' }, 'T');
  assert.ok(engine.timers.size > 0, '恢复后重新排上');
  engine.clearTimers();
});

test('viewerState 下发暂停状态', () => {
  const s = playingState();
  assert.equal(viewerState(s, 'T').paused, null);
  applyAction(s, { type: 'pause' }, 'H');
  const view = viewerState(s, 'T');
  assert.equal(view.paused.bySeat, s.players.find(p => p.id === 'H').seat);
  assert.equal(view.paused.auto, false);
  assert.equal(typeof view.paused.at, 'number');
});

// ⚠️ 上面那条只测了 shiftDeadlines 本身，没走 resumeGame ——
// 变异测试证明「resumeGame 里根本不调用 shiftDeadlines」也能全绿。
// 这条走完整路径：暂停 → 时间过去 → 恢复 → 截止时刻确实后移了。
test('端到端：暂停十分钟再恢复，出牌倒计时不会一恢复就超时', () => {
  const s = playingState();
  const deadline = Date.now() + 30_000;   // 还有 30 秒该出牌
  s.round.playDeadline = deadline;
  s.round.roundEndDeadline = deadline;

  applyAction(s, { type: 'pause' }, 'T');
  s.paused.at -= 10 * 60_000;             // 模拟已经暂停了十分钟
  applyAction(s, { type: 'resume' }, 'T');

  // ⚠️ 断言必须看「截止时刻有没有被推后」，不能只看「恢复后还剩多少秒」——
  // 测试里几乎没有真实时间流逝，即使完全不后移，剩余秒数看着也还是 30 秒，
  // 变异体就这么活下来了。
  assert.ok(
    s.round.playDeadline - deadline > 590_000,
    `出牌截止时刻应当整体后移约 600 秒，实际后移 ${Math.round((s.round.playDeadline - deadline) / 1000)} 秒`
  );
  assert.ok(s.round.roundEndDeadline - deadline > 590_000);
  assert.ok(s.round.playDeadline > Date.now() + 25_000, '恢复后还该剩 ~30 秒可出牌');
  assert.match(s.log.map(l => l.text).join('\n'), /恢复了游戏（暂停了 60\d 秒）/);
});

test('暂停期间电脑不出手', async () => {
  const { BotController } = await import('../bot-controller.js');
  const s = playingState();
  // ⚠️ 座位是按 rng 分配的，别假设 T 就在座位 0 —— 第一版这么假设，
  // 结果把 T 自己设成了电脑，resume 被 FORBIDDEN 挡住，测试反而红得莫名其妙。
  const human = s.players.find(p => p.id === 'T');
  for (const p of s.players) if (p.id !== 'T') p.isBot = true;
  for (const p of s.players) p.hand = [{ id: `h${p.seat}`, suit: 'S', rank: 5 + p.seat }];
  s.round.turnSeat = s.players.find(p => p.isBot).seat; // 轮到一个电脑
  s.round.leadSeat = s.round.turnSeat;
  void human;
  const engine = new GameEngine({ state: s, broadcast: () => {} });
  const bots = new BotController({ engine, difficulty: 'expert', delayMs: 0 });

  assert.notEqual(bots.nextDecision(), null, '正常情况下电脑有动作可做');
  engine.applyAction({ type: 'pause' }, 'T');
  assert.equal(bots.nextDecision(), null, '暂停中电脑必须收手');
  engine.applyAction({ type: 'resume' }, 'T');
  assert.notEqual(bots.nextDecision(), null, '恢复后接着打');
  engine.clearTimers();
});

test('电脑不能暂停游戏（与「电脑不能恢复」对称）', () => {
  const s = playingState();
  s.players.find(p => p.id === 'B').isBot = true;
  const res = applyAction(s, { type: 'pause' }, 'B');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, ErrorCode.FORBIDDEN);
  assert.equal(s.paused, null);
});

// ---- 客户端倒计时也必须冻住 ----
//
// Glen 实测发现：暂停后右上角的倒计时还在继续跌。
// 服务端确实停了计时器、也没动截止时刻，但客户端的 now 是【真实时间】，
// 不冻结的话界面照跌 —— 暂停十分钟回来一看全是 0:00，一恢复又跳回原来的秒数。
test('displayNow：暂停时把「现在」冻结在暂停发生的那一刻', async () => {
  const { displayNow, secondsLeft } = await import('../../client/src/useNow.js');
  const pausedAt = 1_000_000;
  const deadline = pausedAt + 30_000;

  // 没暂停 → 用真实时间
  assert.equal(displayNow({ paused: null }, pausedAt + 20_000), pausedAt + 20_000);
  assert.equal(displayNow(undefined, 12345), 12345);

  // 暂停中 → 无论真实时间走多远，都停在 paused.at
  const game = { paused: { bySeat: 0, auto: false, at: pausedAt } };
  assert.equal(displayNow(game, pausedAt + 10 * 60_000), pausedAt);

  // 倒计时显示因此不动
  const shown = secondsLeft(deadline, displayNow(game, pausedAt + 10 * 60_000));
  assert.equal(shown, 30, '暂停十分钟后界面上仍应显示 30 秒');
});
