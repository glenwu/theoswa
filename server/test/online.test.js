import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../state.js';
import { applyAction } from '../actions.js';
import { nextOnlineToasts, onlineEventsIn, onlineKey } from '../../client/src/onlineToast.js';

const seeded = () => 0.42;
const onlineEvents = state => state.log.filter(l => l.event === 'ONLINE');

// ============ 服务端：上线播报 ============

test('真人上线：写入带 event/playerId 的日志，文案是欢迎语', () => {
  const state = createInitialState(seeded);
  applyAction(state, { type: 'join' }, 'T');
  const events = onlineEvents(state);
  assert.equal(events.length, 1);
  assert.equal(events[0].playerId, 'T');
  assert.equal(events[0].kind, 'SYSTEM', '仍然是系统消息，消息流照常渲染');
  assert.match(events[0].text, /勝 已上线，大家欢迎！/);
});

test('已在线时重复 join 不再播报（开第二个标签页不该打扰另外三家）', () => {
  const state = createInitialState(seeded);
  applyAction(state, { type: 'join' }, 'T');
  applyAction(state, { type: 'join' }, 'T');
  applyAction(state, { type: 'join' }, 'T');
  assert.equal(onlineEvents(state).length, 1);
});

// 网络抖动会让同一个人在几秒内反复 leave/join。没有冷却就会连弹好几条。
test('掉线后 60 秒内重连：仍记日志，但不带 event（不弹提示）', () => {
  const state = createInitialState(seeded);
  applyAction(state, { type: 'join' }, 'T');
  applyAction(state, { type: 'leave' }, 'T');
  applyAction(state, { type: 'join' }, 'T');

  assert.equal(onlineEvents(state).length, 1, '冷却期内不再产生上线事件');
  const welcomes = state.log.filter(l => /已上线/.test(l.text));
  assert.equal(welcomes.length, 2, '流水账不能断：两次上线都要有日志');
});

test('掉线超过冷却窗口再回来：重新播报', () => {
  const state = createInitialState(seeded);
  applyAction(state, { type: 'join' }, 'T');
  applyAction(state, { type: 'leave' }, 'T');
  // 把上一条上线事件的时间戳推到冷却窗口之外
  for (const l of state.log) if (l.event === 'ONLINE') l.ts -= 61_000;
  applyAction(state, { type: 'join' }, 'T');
  assert.equal(onlineEvents(state).length, 2);
});

test('接管电脑位：也播报，文案里点明接管了电脑', () => {
  const state = createInitialState(seeded);
  const t = state.players.find(p => p.id === 'T');
  t.isBot = true;
  t.connected = true;
  applyAction(state, { type: 'join' }, 'T');
  const events = onlineEvents(state);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /接管了电脑玩家的位置/);
  assert.equal(t.isBot, false);
});

test('不同的人各自播报，互不影响冷却', () => {
  const state = createInitialState(seeded);
  for (const id of ['T', 'H', 'B', 'M']) applyAction(state, { type: 'join' }, id);
  assert.deepEqual(onlineEvents(state).map(e => e.playerId), ['T', 'H', 'B', 'M']);
});

// ============ 客户端：哪些提示该弹 ============

const ev = (playerId, ts) => ({ kind: 'SYSTEM', event: 'ONLINE', playerId, ts, text: '' });

test('首帧只立基线，不弹任何提示（刚连上会收到 200 条历史日志）', () => {
  const log = [ev('H', 1), ev('B', 2), { kind: 'SYSTEM', text: '发牌完成', ts: 3 }];
  const { fresh, seen } = nextOnlineToasts(log, 'T', null);
  assert.deepEqual(fresh, [], '历史上线记录一条都不弹');
  assert.equal(seen.size, 2, '但全部收进基线');
});

test('基线之后新来的才弹，且只弹一次（每次广播都重发整条 log）', () => {
  const log1 = [ev('H', 1)];
  const first = nextOnlineToasts(log1, 'T', null);

  const log2 = [ev('H', 1), ev('B', 5)];
  const second = nextOnlineToasts(log2, 'T', first.seen);
  assert.deepEqual(second.fresh.map(e => e.playerId), ['B']);

  // 同一条日志再来一次（出一张牌就会重发）→ 不能重复弹
  const third = nextOnlineToasts(log2, 'T', second.seen);
  assert.deepEqual(third.fresh, []);
});

test('自己的上线不弹给自己', () => {
  const log = [ev('T', 1), ev('H', 2)];
  const { fresh } = nextOnlineToasts(log, 'T', new Set());
  assert.deepEqual(fresh.map(e => e.playerId), ['H']);
  assert.deepEqual(onlineEventsIn(log, 'T').map(e => e.playerId), ['H']);
});

test('同一人两次上线（中间隔了冷却）是两条不同的提示', () => {
  const log = [ev('H', 1), ev('H', 99_000)];
  const { fresh } = nextOnlineToasts(log, 'T', new Set());
  assert.equal(fresh.length, 2);
  assert.notEqual(onlineKey(fresh[0]), onlineKey(fresh[1]), 'key 含时间戳，不会互相顶掉');
});

test('日志为空 / 未定义都不炸', () => {
  assert.deepEqual(nextOnlineToasts(undefined, 'T', null).fresh, []);
  assert.deepEqual(nextOnlineToasts([], 'T', new Set()).fresh, []);
  assert.deepEqual(onlineEventsIn(null, 'T'), []);
});

test('普通系统日志不会被误认成上线事件', () => {
  const log = [{ kind: 'SYSTEM', text: '勝 已上线，大家欢迎！', ts: 1 }]; // 冷却期内那种：无 event
  assert.deepEqual(nextOnlineToasts(log, 'T', new Set()).fresh, []);
});
