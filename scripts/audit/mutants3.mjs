
import { runMutants } from './mutate.mjs';

runMutants([
  ['server/game-engine.js', "} else if (s.phase === 'KITTY_EXCHANGE') {", "} else if (s.phase === '__NEVER__') {", '换底兜底计时器被拿掉（回到旧的卡死状态）'],
  ['server/game-engine.js', "} else if (s.phase === 'DOMINANCE') {", "} else if (s.phase === '__NEVER__2__') {", '碾压兜底计时器被拿掉'],
  ['server/state.js', 'timing: { ...DEFAULT_TIMINGS },', 'timing: { ...DEFAULT_TIMINGS, kittyExchangeMs: undefined },', '又出现一份漏键的 timing（NaN 立刻触发）'],
  ['server/constants.js', "  kittyExchangeMs: 'KITTY_MS',", '', '新节奏漏配环境变量名'],
  ['server/game-engine.js', 'const cards = chooseKittyCards(declarer.hand, {', 'const cards = ((h) => h.slice(0, 8))(declarer.hand, {', '自动埋底改成随手抓前 8 张（会埋掉大鬼）'],
]);
