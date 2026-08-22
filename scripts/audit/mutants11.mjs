// 变异测试：电脑托管。
import { runMutants } from './mutate.mjs';
const A = 'server/actions.js';
const B = 'server/bot-controller.js';
const V = 'server/viewer.js';
runMutants([
  [B, '.filter(player => player.isBot || player.autoPlay)', '.filter(player => player.isBot)', '托管的座位 AI 不代打'],
  [B, '.filter(player => player.isBot || player.autoPlay)', '.filter(player => player.autoPlay)', '电脑座位反而不打了'],
  [A, "  if (me.isBot) return fail(ErrorCode.FORBIDDEN, '电脑玩家无需托管');", '', '电脑也能设托管'],
  [A, '  if (me.autoPlay === on) return succeed(); // 幂等：重复点同一个状态不报错、不刷日志', '', '重复点会刷日志'],
  [A, '  const on = action.on !== false; // 缺省视为开启', '  const on = action.on === true;', '缺省从「开启」变成「关闭」'],
  [A, '  me.autoPlay = on;', '  me.autoPlay = true;', '托管只能开不能关'],
  [A, '    me.autoPlay = false; // 人回来了就是要自己打，别让上一局的托管标记留着', '', '真人回来后托管标记还留着'],
  [A, "'pause', 'resume', 'setAutoPlay',\n  'proposeReset'", "'pause', 'resume',\n  'proposeReset'", 'setAutoPlay 受陈旧状态防护影响'],
  [A, "'pause', 'resume', 'setAutoPlay']);", "'pause', 'resume']);", '暂停期间不能开关托管'],
  [V, '      autoPlay: p.autoPlay === true, // 托管中（公开：四家都该知道这一家是 AI 在打）', '', '不把托管状态告诉其他人'],
]);
