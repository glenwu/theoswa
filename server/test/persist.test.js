import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInitialState } from '../state.js';
import { mulberry32 } from '../rng.js';
import { serializeState, loadSavedGame, saveGame, clearSave } from '../persist.js';

test('持久化往返：保存 → 读取 → 关键字段一致；rng 状态续流', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csu-'));
  const file = path.join(dir, 'save.json');

  const state = createInitialState(() => 0.42);
  state.seed = 42;
  state.rng = mulberry32(42);
  state.phase = 'PLAYING';
  state.teamLevels = [3, 5];
  state.declarerSeat = 2;
  state.rounds.push({ roundNumber: 1, defenderPoints: 80 });
  // 消耗一段随机流，验证续流
  const rngBefore = state.rng.state();
  state.rng();
  state.rng();
  state.rng();
  saveGame(state, file);

  const loaded = loadSavedGame(file);
  assert.ok(loaded, '可读取');
  assert.equal(loaded.phase, 'PLAYING');
  assert.deepEqual(loaded.teamLevels, [3, 5]);
  assert.equal(loaded.declarerSeat, 2);
  assert.equal(loaded.rounds.length, 1);
  assert.equal(loaded.seed, 42);
  assert.equal(typeof loaded.rngState, 'number', 'rng 内部状态已保存');
  // 续流：恢复后的 rng 与保存前消耗 3 次后的状态一致 → 后续序列完全一致
  const revived = mulberry32(loaded.rngState);
  const continued = mulberry32(rngBefore);
  continued(); continued(); continued();
  for (let i = 0; i < 5; i++) {
    assert.equal(revived(), continued(), `rng 续流第 ${i} 次一致`);
  }
});

test('持久化：损坏 / 过期存档返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csu-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, 'not json');
  assert.equal(loadSavedGame(bad), null);

  const expired = path.join(dir, 'old.json');
  fs.writeFileSync(expired, JSON.stringify({ savedAt: Date.now() - 13 * 3600 * 1000, game: { phase: 'PLAYING' } }));
  assert.equal(loadSavedGame(expired), null, '超过 12 小时过期');

  const fresh = path.join(dir, 'fresh.json');
  fs.writeFileSync(
    fresh,
    JSON.stringify({
      savedAt: Date.now(),
      game: { phase: 'PLAYING', players: [{}, {}, {}, {}], teamLevels: [0, 0] },
    })
  );
  assert.equal(loadSavedGame(fresh).phase, 'PLAYING');
});

test('持久化迁移：旧版本存档缺新字段时按默认补齐', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csu-'));
  const file = path.join(dir, 'old-era.json');

  // 模拟阶段5时代的存档：没有 adminIds / resetProposal / saveClearRequested
  const state = createInitialState(() => 0.42);
  state.seed = 42;
  state.rng = mulberry32(42);
  state.phase = 'PLAYING';
  const old = JSON.parse(serializeState(state));
  delete old.game.adminIds;
  delete old.game.resetProposal;
  delete old.game.saveClearRequested;
  delete old.game.rounds;
  fs.writeFileSync(file, JSON.stringify(old));

  const loaded = loadSavedGame(file);
  assert.ok(loaded, '旧存档可恢复');
  assert.deepEqual(loaded.adminIds, [], 'adminIds 补默认');
  assert.equal(loaded.resetProposal, null, 'resetProposal 补默认');
  assert.equal(loaded.saveClearRequested, false, 'saveClearRequested 补默认');
  assert.deepEqual(loaded.rounds, [], 'rounds 补默认');
  assert.equal(loaded.phase, 'PLAYING', '已有字段不动');
  assert.equal(loaded.seed, 42);
});

test('持久化迁移：已有字段不被覆盖（adminIds 保留）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csu-'));
  const file = path.join(dir, 'keep.json');

  const state = createInitialState(() => 0.42);
  state.rng = mulberry32(42);
  state.adminIds = ['T', 'H'];
  state.resetProposal = { fromSeat: 1, yesSeats: [1], reshuffleSeats: false, deadline: 123 };
  state.saveClearRequested = true;
  saveGame(state, file);

  const loaded = loadSavedGame(file);
  assert.deepEqual(loaded.adminIds, ['T', 'H']);
  assert.deepEqual(loaded.resetProposal, { fromSeat: 1, yesSeats: [1], reshuffleSeats: false, deadline: 123 });
  assert.equal(loaded.saveClearRequested, true);
});

test('持久化迁移：结构损坏（players 缺失/不足 4 人）返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csu-'));
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), game: { phase: 'PLAYING' } }));
  assert.equal(loadSavedGame(file), null, '无 players 视为损坏');
  fs.writeFileSync(
    file,
    JSON.stringify({ savedAt: Date.now(), game: { phase: 'PLAYING', players: [{}], teamLevels: [0, 0] } })
  );
  assert.equal(loadSavedGame(file), null, '不足 4 人视为损坏');
});

test('持久化：clearSave 删除文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csu-'));
  const file = path.join(dir, 'x.json');
  saveGame(createInitialState(() => 0.42), file);
  clearSave(file);
  assert.equal(fs.existsSync(file), false);
});

test('序列化丢弃函数字段（rng 不进入 JSON，仅保存 rngState 数字）', () => {
  const state = createInitialState(() => 0.42);
  const json = serializeState(state);
  assert.ok(!json.includes('"rng"'), 'rng 键（函数）不序列化');
  assert.ok(json.includes('"rngState"'));
});
