import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat, playerById } from '../state.js';
import { applyAction, ErrorCode } from '../actions.js';
import { GameEngine } from '../game-engine.js';
import { BotController } from '../bot-controller.js';
import { viewerState } from '../viewer.js';

const seeded = () => 0.42;

function joinedPlaying() {
  const s = createInitialState(seeded);
  for (const id of ['T', 'H', 'B', 'M']) applyAction(s, { type: 'join' }, id);
  s.phase = 'PLAYING';
  s.declarerSeat = 0;
  s.round = createRoundState(1, 0);
  s.round.trumpSuit = 'S';
  s.round.rankCard = 2;
  s.round.leadSeat = 0;
  s.round.turnSeat = 0;
  return s;
}

// 「托管」和「把座位换成电脑」是两回事：
//   addBot → 座位变成电脑，人已经不在了（只对掉线座位开放）
//   托管   → 人还连着、身份不变、随时能自己取消，只是让 AI 代打
test('托管开关：自己开、自己关，身份和在线状态都不变', () => {
  const s = joinedPlaying();
  const me = playerById(s, 'T');
  assert.equal(me.autoPlay, false);

  assert.equal(applyAction(s, { type: 'setAutoPlay', on: true }, 'T').ok, true);
  assert.equal(me.autoPlay, true);
  assert.equal(me.isBot, false, '托管不会把人变成电脑');
  assert.equal(me.connected, true, '人还在线');
  assert.match(s.log.map(l => l.text).join('\n'), /开启了电脑托管/);

  assert.equal(applyAction(s, { type: 'setAutoPlay', on: false }, 'T').ok, true);
  assert.equal(me.autoPlay, false);
  assert.match(s.log.map(l => l.text).join('\n'), /取消了电脑托管/);
});

test('托管开关幂等：重复点同一个状态不报错、也不刷日志', () => {
  const s = joinedPlaying();
  applyAction(s, { type: 'setAutoPlay', on: true }, 'T');
  const before = s.log.length;
  assert.equal(applyAction(s, { type: 'setAutoPlay', on: true }, 'T').ok, true);
  assert.equal(s.log.length, before, '状态没变就不该再写一条日志');
});

test('托管只能给自己设；电脑玩家不需要托管', () => {
  const s = joinedPlaying();
  playerById(s, 'B').isBot = true;
  const res = applyAction(s, { type: 'setAutoPlay', on: true }, 'B');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, ErrorCode.FORBIDDEN);
});

test('托管的座位由 AI 代打（和电脑一视同仁）', () => {
  const s = joinedPlaying();
  for (const p of s.players) p.hand = [{ id: `h${p.seat}`, suit: 'S', rank: 5 + p.seat }];
  const turnPlayer = playerBySeat(s, 0);
  const engine = new GameEngine({ state: s, broadcast: () => {} });
  const bots = new BotController({ engine, difficulty: 'expert', delayMs: 0 });

  assert.equal(bots.nextDecision(), null, '没人托管、也没有电脑 → AI 不该出手');
  engine.applyAction({ type: 'setAutoPlay', on: true }, turnPlayer.id);
  const decision = bots.nextDecision();
  assert.notEqual(decision, null, '托管后该由 AI 替他出牌');
  assert.equal(decision.playerId, turnPlayer.id, '用的是他自己的身份和手牌');
  engine.clearTimers();
});

// 托管的人是【主动】把牌交给 AI 的，牌局就该继续走，
// 不能因为他不在键盘前就把全场停住。
test('托管不触发自动暂停（他依然算在线真人）', () => {
  const s = joinedPlaying();
  for (const id of ['H', 'B', 'M']) playerById(s, id).isBot = true;
  applyAction(s, { type: 'setAutoPlay', on: true }, 'T');
  assert.equal(s.paused, null, '托管不是离线');
  // 但真的掉线了还是要暂停
  applyAction(s, { type: 'leave' }, 'T');
  assert.notEqual(s.paused, null);
});

test('暂停期间仍可开关托管（趁暂停安排好再走）', () => {
  const s = joinedPlaying();
  applyAction(s, { type: 'pause' }, 'H');
  assert.equal(applyAction(s, { type: 'setAutoPlay', on: true }, 'T').ok, true);
  assert.equal(playerById(s, 'T').autoPlay, true);
});

test('真人回来接管电脑位时，顺手清掉托管标记', () => {
  const s = joinedPlaying();
  const me = playerById(s, 'T');
  me.autoPlay = true;
  me.isBot = true;
  me.connected = false;
  applyAction(s, { type: 'join' }, 'T');
  assert.equal(me.isBot, false);
  assert.equal(me.autoPlay, false, '人回来就是要自己打');
});

test('viewerState 公开托管状态（四家都该知道这一家是 AI 在打）', () => {
  const s = joinedPlaying();
  applyAction(s, { type: 'setAutoPlay', on: true }, 'H');
  const view = viewerState(s, 'T');
  const seatH = view.players.find(p => p.id === 'H');
  assert.equal(seatH.autoPlay, true);
  assert.equal(seatH.isBot, false, '托管不是电脑，两个标记要分开');
  assert.equal(view.you.autoPlay, false, '我自己没托管');
});

test('不带 on 参数视为开启（按钮只发 {type} 时也能用）', () => {
  const s = joinedPlaying();
  assert.equal(applyAction(s, { type: 'setAutoPlay' }, 'T').ok, true);
  assert.equal(playerById(s, 'T').autoPlay, true, '缺省是开启，不是关闭');
});

// 客户端每个动作都会带上自己以为的 phase（陈旧界面防护）。
// 托管开关跟阶段无关 —— 正要托管的人多半就是没盯着屏幕，
// 手里那份 phase 很可能已经过期了，这时候被 STALE_STATE 拒掉最不该。
test('托管开关不受陈旧状态防护影响（跟阶段无关）', () => {
  const s = joinedPlaying(); // 实际 phase 是 PLAYING
  const res = applyAction(s, { type: 'setAutoPlay', on: true, phase: 'SEATING' }, 'T');
  assert.equal(res.ok, true, `带着过期的 phase 也该放行，实际 ${res.error?.code}`);
  assert.equal(playerById(s, 'T').autoPlay, true);
});
