import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../state.js';
import { applyAction, ErrorCode } from '../actions.js';
import { alternatingSuitOrder } from '../cards.js';
import { saveGame, loadSavedGame } from '../persist.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const seeded = () => 0.42;

function joinedState() {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  return state;
}

const seatsOf = state => Object.fromEntries(state.players.map(p => [p.id, p.seat]));

test('新开一局提案：四人全同意才执行；任一人拒绝立即取消', () => {
  const state = joinedState();
  state.teamLevels = [5, 7];
  state.rounds.push({ roundNumber: 3 });
  state.phase = 'PLAYING';

  // 发起（发起者视为已同意）
  assert.equal(applyAction(state, { type: 'proposeReset', reshuffleSeats: false }, 'T').ok, true);
  assert.ok(state.resetProposal);
  assert.deepEqual(state.resetProposal.yesSeats, [state.seatsByPlayer.T]);
  // 重复发起被拒
  assert.equal(applyAction(state, { type: 'proposeReset' }, 'H').error.code, ErrorCode.PROPOSAL_ACTIVE);
  // 发起者不能投票
  assert.equal(applyAction(state, { type: 'voteReset', agree: true }, 'T').error.code, ErrorCode.ALREADY_VOTED);

  // 第二人同意
  applyAction(state, { type: 'voteReset', agree: true }, 'H');
  assert.equal(state.resetProposal.yesSeats.length, 2);
  // 重复投票被拒
  assert.equal(applyAction(state, { type: 'voteReset', agree: true }, 'H').error.code, ErrorCode.ALREADY_VOTED);
  // 第三人同意
  applyAction(state, { type: 'voteReset', agree: true }, 'B');
  // 未执行（3/4）
  assert.ok(state.teamLevels[0] === 5, '尚未执行');
  // 第四人同意 → 执行
  applyAction(state, { type: 'voteReset', agree: true }, 'M');
  assert.equal(state.resetProposal, null);
  assert.deepEqual(state.teamLevels, [0, 0], '级别归零');
  assert.equal(state.rounds.length, 0, '局数归零');
  assert.equal(state.declarerSeat, null);
  assert.equal(state.saveClearRequested, true, '请求清档');
});

test('新开一局提案：任一人拒绝立即取消', () => {
  const state = joinedState();
  applyAction(state, { type: 'proposeReset', reshuffleSeats: true }, 'T');
  applyAction(state, { type: 'voteReset', agree: true }, 'H');
  assert.equal(applyAction(state, { type: 'voteReset', agree: false }, 'B').ok, true);
  assert.equal(state.resetProposal, null, '立即取消');
  assert.equal(state.teamLevels[0], 0);
  assert.ok(state.log.some(l => l.text.includes('拒绝了新开一局')));
  // 取消后可重新发起
  assert.equal(applyAction(state, { type: 'proposeReset' }, 'M').ok, true);
});

test('新开一局提案：60 秒超时自动取消（引擎计时）', async () => {
  const { GameEngine } = await import('../game-engine.js');
  const state = joinedState();
  const engine = new GameEngine({ state, timings: { resetProposalMs: 60 }, broadcast: () => {} });
  // 走引擎入口，让 afterAction 重排计时器
  assert.equal(engine.applyAction({ type: 'proposeReset' }, 'T').ok, true);
  assert.ok(state.resetProposal);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(state.resetProposal, null, '超时自动取消');
  assert.ok(state.log.some(l => l.text.includes('提案超时')));
  engine.clearTimers();
});

test('新开一局提案：可存档并在重启后恢复（含截止时刻）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csu-'));
  const file = path.join(dir, 'save.json');
  const state = joinedState();
  applyAction(state, { type: 'proposeReset' }, 'T');
  applyAction(state, { type: 'voteReset', agree: true }, 'H');
  saveGame(state, file);

  const loaded = loadSavedGame(file);
  assert.ok(loaded.resetProposal, '提案随存档保存');
  assert.equal(loaded.resetProposal.fromSeat, state.resetProposal.fromSeat);
  assert.deepEqual(loaded.resetProposal.yesSeats, [state.resetProposal.yesSeats[0], state.resetProposal.yesSeats[1]]);
  assert.equal(typeof loaded.resetProposal.deadline, 'number', '截止时刻保留');
});

test('管理员强制重置：无权限者即使伪造动作也被服务端拒绝；持口令者可执行', () => {
  const state = joinedState();
  state.teamLevels = [4, 3];
  // 无管理员身份 → 拒绝
  const denied = applyAction(state, { type: 'forceReset', reshuffleSeats: false }, 'T');
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, ErrorCode.FORBIDDEN);
  assert.equal(state.teamLevels[0], 4, '未执行');
  // 授予管理员身份（模拟带 ?RESET=口令 连接）
  state.adminIds.push('T');
  const ok = applyAction(state, { type: 'forceReset', reshuffleSeats: false }, 'T');
  assert.equal(ok.ok, true);
  assert.deepEqual(state.teamLevels, [0, 0]);
  assert.equal(state.phase, 'READY_CHECK', '座位保留 → 直接准备');
  assert.ok(state.log.some(l => l.text.includes('强制重置')));
  assert.equal(state.saveClearRequested, true);
});

test('花色交替：四种主牌花色下，副牌组顺序均为红黑交替', () => {
  const isRed = s => s === 'H' || s === 'D';
  for (const trump of ['S', 'H', 'D', 'C']) {
    const order = alternatingSuitOrder(trump);
    assert.equal(order.length, 3, `主牌 ${trump} 剩 3 门`);
    assert.ok(order.every(s => s !== trump), '不含主牌花色');
    for (let i = 1; i < order.length; i++) {
      assert.notEqual(isRed(order[i - 1]), isRed(order[i]), `主牌 ${trump}：${order.join(',')} 相邻同色`);
    }
  }
});

test('提案投票时旧阶段动作互不影响（提案与阶段无关）', () => {
  const state = joinedState();
  state.phase = 'SEATING';
  applyAction(state, { type: 'proposeReset' }, 'T');
  // SEATING 阶段仍可换座提案等正常动作
  const h = state.players.find(p => p.id === 'H');
  assert.equal(applyAction(state, { type: 'proposeSwap', targetSeat: h.seat }, 'T').ok, true);
});
