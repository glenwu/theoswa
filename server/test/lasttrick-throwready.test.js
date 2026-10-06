import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lastFinishedTrick, lastTrickRows } from '../../client/src/lastTrickView.js';
import { throwReadySuits } from '../../client/src/throwReady.js';

const root = path.join(import.meta.dirname, '..', '..');
const panel = readFileSync(path.join(root, 'client/src/components/TablePanel.jsx'), 'utf8');
const css = readFileSync(path.join(root, 'client/src/styles.css'), 'utf8');

const T = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
const trick = (no, plays, winnerSeat, points = 0) => ({
  trickNo: no, leadSeat: plays[0].seat, leadSuit: 'S', winnerSeat, points, plays,
});

// ============ 看上一轮 ============

test('看上一轮：取最近打完的那一墩', () => {
  const round = {
    trickHistory: [
      trick(1, [{ seat: 0, cards: [T('S', 4, 1)] }], 0),
      trick(2, [{ seat: 2, cards: [T('D', 9, 2)] }], 2, 5),
    ],
  };
  assert.equal(lastFinishedTrick(round).trickNo, 2);
});

// 碾压收尾补的那一手 plays 是空的 —— 点开只会看到一墩空牌
test('看上一轮：跳过碾压收尾补的空墩，往前取真打过的那一墩', () => {
  const round = {
    trickHistory: [
      trick(1, [{ seat: 0, cards: [T('S', 4, 1)] }], 0),
      { trickNo: 2, leadSeat: 1, winnerSeat: 1, points: 30, plays: [], virtual: true },
    ],
  };
  assert.equal(lastFinishedTrick(round).trickNo, 1);
});

test('看上一轮：一墩都还没打完 → 没有可看的（按钮不该出现）', () => {
  assert.equal(lastFinishedTrick({ trickHistory: [] }), null);
  assert.equal(lastFinishedTrick(undefined), null);
});

test('看上一轮：按出牌顺序列出四家，标出领牌人和赢家', () => {
  const rows = lastTrickRows(trick(3, [
    { seat: 1, cards: [T('S', 13, 1)] },
    { seat: 0, cards: [T('S', 4, 2)] },
    { seat: 3, cards: [T('S', 14, 3)] },
    { seat: 2, cards: [T('S', 5, 4)] },
  ], 3, 25));
  assert.deepEqual(rows.map(r => r.seat), [1, 0, 3, 2]);
  assert.deepEqual(rows.map(r => r.isLead), [true, false, false, false]);
  assert.deepEqual(rows.map(r => r.isWinner), [false, false, true, false]);
});

test('看上一轮：甩牌那一手的牌全部列出来', () => {
  const rows = lastTrickRows(trick(4, [
    { seat: 1, cards: [T('S', 9, 1), T('S', 8, 2), T('S', 7, 3)] },
  ], 1));
  assert.equal(rows[0].cards.length, 3);
});

// ============ 可甩的那门亮呼吸光 ============

const ALL_SEEN = () => [14, 14, 13, 13].map(rank => ({ rank, status: 'seen' }));
const ALL_UNSEEN = () => [14, 14, 13, 13].map(rank => ({ rank, status: 'unseen' }));
const readyView = ({ hand, piecesView, phase = 'PLAYING' }) => ({
  phase,
  you: { hand },
  round: { trumpSuit: 'H', rankCard: 2, piecesView },
});

test('呼吸光：件全现 + 手上 2 张以上 → 这门亮灯', () => {
  const suits = throwReadySuits(readyView({
    hand: [T('S', 9, 1), T('S', 7, 2), T('D', 9, 3), T('D', 8, 4)],
    piecesView: { S: ALL_SEEN(), D: ALL_UNSEEN(), C: ALL_UNSEEN() },
  }));
  assert.deepEqual([...suits], ['S']);
});

test('呼吸光：件还没出完 → 不亮', () => {
  const suits = throwReadySuits(readyView({
    hand: [T('S', 9, 1), T('S', 7, 2)],
    piecesView: {
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'seen' }],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
  }));
  assert.equal(suits.size, 0);
});

// 件在我手上也算「现过」（canThrowByStatus 只排除 unseen）—— 这是服务端的口径
test('呼吸光：件在我自己手上 → 照样算甩得出去', () => {
  const suits = throwReadySuits(readyView({
    hand: [T('S', 14, 1), T('S', 9, 2), T('S', 7, 3)],
    piecesView: {
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'seen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' }],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
  }));
  assert.deepEqual([...suits], ['S']);
});

test('呼吸光：这门只剩 1 张 → 不亮（那是普通领牌，不是甩）', () => {
  const suits = throwReadySuits(readyView({
    hand: [T('S', 9, 1), T('D', 8, 2)],
    piecesView: { S: ALL_SEEN(), D: ALL_SEEN(), C: ALL_SEEN() },
  }));
  assert.equal(suits.size, 0);
});

test('呼吸光：主牌不亮（主牌甩牌是另一套判定）', () => {
  const suits = throwReadySuits(readyView({
    hand: [T('H', 9, 1), T('H', 7, 2)],
    piecesView: { S: ALL_SEEN(), D: ALL_SEEN(), C: ALL_SEEN() },
  }));
  assert.equal(suits.size, 0);
});

test('呼吸光：不在出牌阶段不亮（换底时手上有 33 张，满屏灯没意义）', () => {
  const suits = throwReadySuits(readyView({
    hand: [T('S', 9, 1), T('S', 7, 2)],
    piecesView: { S: ALL_SEEN(), D: ALL_SEEN(), C: ALL_SEEN() },
    phase: 'KITTY_EXCHANGE',
  }));
  assert.equal(suits.size, 0);
});

// ============ 接线（和 controlbar/landscape 那几条一样，按源码文本钉住）============

test('接线：控制栏有「看上一轮」按钮，手牌区按 throwReadySuits 套光圈', () => {
  assert.match(panel, /看上一轮/, '控制栏要有「看上一轮」按钮');
  assert.match(panel, /throwReadySuits/, '手牌区要用 throwReadySuits 判定亮哪门');
  assert.match(panel, /throw-ready/, '光圈走 CSS 类 throw-ready');
});

test('接线：呼吸光的动画和「减少动态效果」的降级都在 CSS 里', () => {
  assert.match(css, /\.throw-ready\s*\{[^}]*animation:\s*throw-ready-breathe/);
  assert.match(css, /@keyframes throw-ready-breathe/);
  const reduced = css.slice(css.indexOf('.throw-ready'));
  assert.match(reduced, /prefers-reduced-motion[\s\S]*throw-ready/,
    '开了「减少动态效果」要停掉呼吸、只留静态光圈');
});
