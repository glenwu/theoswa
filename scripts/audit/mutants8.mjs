
import { runMutants } from './mutate.mjs';

runMutants([
  ['server/pause.js', 'shiftDeadlines(state, elapsed);', '', '恢复时不把截止时刻后移（全部立刻触发）'],
  ['server/pause.js', "  'playDeadline',\n", '', '漏登记一个 Deadline 字段'],
  ['server/pause.js', 'if (typeof cross.decideDeadline === \'number\') cross.decideDeadline += delta;', '', '过河倒计时不后移'],
  ['server/pause.js', 'state.resetProposal.deadline += delta;', '', '新开一局提案倒计时不后移'],
  ['server/pause.js', 'if (!Number.isFinite(delta) || delta <= 0) return state;', 'if (false) return state;', '非法 delta 也照算'],
  ['server/pause.js', "return state.round !== null && state.phase !== 'GAME_OVER';", 'return true;', '开局前/结束后也自动暂停'],
  ['server/pause.js', 'return (state.players ?? []).some(player => player.connected && !player.isBot);', 'return (state.players ?? []).some(player => player.connected);', '把电脑也算成在线真人'],
  ['server/actions.js', "if (state.paused && !ALLOWED_WHILE_PAUSED.has(action?.type)) {", 'if (false) {', '暂停期间照样能出牌'],
  ['server/actions.js', "if (me.isBot) return fail(ErrorCode.FORBIDDEN, '电脑不能恢复游戏');", '', '电脑也能恢复游戏'],
  ['server/actions.js', "  if (!state.paused && autoPauseApplies(state) && !hasConnectedHuman(state)) {", '  if (false) {', '真人全离线也不自动暂停'],
  ['server/actions.js', "  if (me.isBot) return fail(ErrorCode.FORBIDDEN, '电脑不能暂停游戏');", '', '电脑也能暂停游戏'],
  ['server/game-engine.js', 'if (s.paused) return;', '', '暂停时计时器照排'],
  ['server/bot-controller.js', 'if (this.engine.state.paused) return null; // 暂停中电脑不出手', '', '暂停时电脑照样出牌'],
]);
