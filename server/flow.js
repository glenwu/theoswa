import { createRoundState, pushLog } from './state.js';

// 每局 READY_CHECK 结束后走向揭牌的分支。
// 判据是“庄家是否已确定”，与第几局无关：
// 第一局流局后 declarerSeat 保持 null，再开一局仍走 REVEAL_FIRST（不会误入 REVEALING）。
export function chooseRevealEntry(state) {
  return state.declarerSeat === null ? 'REVEAL_FIRST' : 'REVEALING';
}

// 流局（庄家未定时揭牌 100 张无人亮牌）：
// 不发牌、不计分、级别不变、局数不变、庄家仍未确定 → 回 READY_CHECK 重新揭牌。
// 防御：流局只可能发生在 declarerSeat === null 时，否则说明流程有 bug。
export function voidRound(state) {
  if (state.declarerSeat !== null) {
    throw new Error('流局防御失败：庄家已定时不可能流局（流程 bug）');
  }
  const roundNumber = state.round ? state.round.roundNumber : 1;
  state.phase = 'READY_CHECK';
  state.declarerSeat = null;
  state.flipperSeat = null;
  state.swapProposals = [];
  state.round = createRoundState(roundNumber, null);
  for (const p of state.players) {
    p.ready = false;
    p.seatLocked = true; // 座位已锁定，流局不重新入座
    p.hand = [];
  }
  pushLog(state, '流局：100 张揭完无人亮牌，级别与局数不变，重新揭牌。');
  return state;
}

// 庄家已定（第二局起）无人亮牌：进入揭底牌定主。
// 防御：该分支只可能发生在 declarerSeat !== null 时（与流局永远互斥）。
export function enterFallback(state) {
  if (state.declarerSeat === null) {
    throw new Error('揭底定主防御失败：庄家未定时不可能揭底（流程 bug）');
  }
  state.phase = 'FALLBACK_TRUMP';
  state.round.fallbackRevealed = [];
  state.round.fallbackSuit = null;
  pushLog(state, '无人亮主，逐张揭底牌定主');
  return state;
}

// 100 张揭完、宽限窗口结束仍无人亮牌 → 流局 或 揭底定主
export function settleNoTrump(state) {
  if (state.declarerSeat === null) {
    voidRound(state);
    return 'VOID';
  }
  enterFallback(state);
  return 'FALLBACK';
}
