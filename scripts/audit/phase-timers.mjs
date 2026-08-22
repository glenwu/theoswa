// 审计：每个阶段是否有服务端计时器兜底（全员挂机时能否自愈）。
import { GameEngine } from '../../server/game-engine.js';
import { createInitialState, createRoundState } from '../../server/state.js';
import { PHASES } from '../../server/constants.js';
import { mulberry32 } from '../../server/rng.js';

const WAITING_BY_DESIGN = new Set(['SEATING', 'READY_CHECK', 'GAME_OVER']);

for (const phase of PHASES) {
  const s = createInitialState(mulberry32(1));
  s.phase = phase;
  s.declarerSeat = 0;
  s.flipperSeat = 0;
  s.round = createRoundState(1, 0);
  const r = s.round;
  r.trumpSuit = phase === 'REVEALING' ? null : 'S'; r.rankCard = 2; r.turnSeat = 0; r.leadSeat = 0;
  r.crossRiver = { doneTeams: [], passedSeats: [], active: [], decideDeadline: Date.now() + 1e6 };
  r.dominance = { winningTeam: 0, remainingTricks: 3, remainingPoints: 20, pointsToDefender: true, kittyGrab: true };
  r.kitty = [{ id: 'k0', suit: 'S', rank: 3 }];
  const engine = new GameEngine({ state: s, broadcast: () => {} });
  const names = [...engine.timers.keys()];
  engine.clearTimers();
  const ok = names.length > 0 || WAITING_BY_DESIGN.has(phase);
  console.log(
    `${(ok ? '  ' : '⚠️').padEnd(3)}${phase.padEnd(16)} 计时器: ${names.length ? names.join(', ') : '（无）'}` +
    (WAITING_BY_DESIGN.has(phase) ? '   ← 设计上就等人' : '')
  );
}
