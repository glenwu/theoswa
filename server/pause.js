// 暂停 / 恢复（纯函数，不碰计时器本身 —— 计时器由 GameEngine.scheduleTimers 重排）。
//
// ⚠️ 真正的难点不是「停下来」，而是【所有截止时刻都是绝对时间戳】：
// 出牌 60 秒、换底 180 秒、本局小结 100 秒、过河 15/30 秒、新开一局提案 60 秒……
// 全都存成 Date.now() + X。暂停十分钟再恢复，这些时刻早就过去了，
// 恢复的瞬间会一口气全部触发：庄家的底自动埋了、出牌自动打了、小结直接跳过。
// 所以恢复时必须把每一个非空的截止时刻整体往后推「暂停了多久」。

// 轮局状态里所有绝对截止时刻的字段名。
// ⚠️ 新增任何 *Deadline 字段都必须加进这张表 —— 有测试逐字段核对
// createRoundState 的产物，漏一个就会红。
export const ROUND_DEADLINE_FIELDS = Object.freeze([
  'drawDeadline',
  'graceDeadline',
  'flipHoldDeadline',
  'kittyDeadline',
  'dominanceDeadline',
  'playDeadline',
  'settleDeadline',
  'roundEndDeadline',
]);

export function shiftDeadlines(state, delta) {
  if (!Number.isFinite(delta) || delta <= 0) return state;
  const round = state.round;
  if (round) {
    for (const key of ROUND_DEADLINE_FIELDS) {
      if (typeof round[key] === 'number') round[key] += delta;
    }
    const cross = round.crossRiver;
    if (cross) {
      if (typeof cross.decideDeadline === 'number') cross.decideDeadline += delta;
      for (const active of cross.active ?? []) {
        if (typeof active.deadline === 'number') active.deadline += delta;
      }
    }
  }
  if (state.resetProposal && typeof state.resetProposal.deadline === 'number') {
    state.resetProposal.deadline += delta;
  }
  return state;
}

// 是否还有在线的真人（电脑不算）
export function hasConnectedHuman(state) {
  return (state.players ?? []).some(player => player.connected && !player.isBot);
}

// 自动暂停只在「牌局进行中」才有意义：开局前没什么可保护的，
// 游戏已经结束了也不用暂停。
export function autoPauseApplies(state) {
  return state.round !== null && state.phase !== 'GAME_OVER';
}

export function pauseGame(state, { bySeat = null, auto = false } = {}) {
  if (state.paused) return false;
  state.paused = { bySeat, auto, at: Date.now() };
  return true;
}

// 返回暂停了多少毫秒（未处于暂停则返回 null）
export function resumeGame(state) {
  if (!state.paused) return null;
  const elapsed = Date.now() - state.paused.at;
  shiftDeadlines(state, elapsed);
  state.paused = null;
  return elapsed;
}
