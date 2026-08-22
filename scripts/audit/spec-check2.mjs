// 审计脚本（不进主干）：需要流程级构造的规则核对。
import { applyAction } from '../../server/actions.js';
import { createInitialState, createRoundState, playerBySeat } from '../../server/state.js';
import { executeCrossRiver } from '../../server/crossriver.js';
import { settleRound, kittyGrabOf } from '../../server/scoring.js';
import { rebuildPieces } from '../../server/pieces.js';

const C = (id, suit, rank) => ({ id, suit, rank });
let pass=0, fail=0; const fails=[];
function check(tag, desc, actual, expected) {
  const ok = JSON.stringify(actual)===JSON.stringify(expected);
  ok ? pass++ : (fail++, fails.push(`${tag} ${desc}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`));
}

function baseState(declarerSeat = 0) {
  const s = createInitialState(() => 0.5);
  s.declarerSeat = declarerSeat;
  s.phase = 'CROSS_RIVER';
  const r = createRoundState(1, declarerSeat);
  r.trumpSuit = 'H'; r.rankCard = 2; r.kitty = [];
  s.round = r;
  for (const p of s.players) { p.hand = []; p.connected = true; }
  return s;
}

// ---- §6.12 过河惩罚：只在「庄家触发」时生效 ----
// 情形 A：庄家(座0)自己发起过河
{
  const s = baseState(0);
  playerBySeat(s,0).hand = [C('t1','H',3),C('t2','H',4),C('t3','H',5)];
  playerBySeat(s,2).hand = [C('x1','S',3),C('x2','S',4),C('x3','S',5)];
  const active = { fromSeat:0, toSeat:2, giveCardIds:['t1','t2','t3'], deadline:0 };
  s.round.crossRiver.active.push(active);
  executeCrossRiver(s, active, ['x1','x2','x3']);
  check('§6.12','庄家自己发起 → declarerCrossedRiver=true', s.round.declarerCrossedRiver, true);
}
// 情形 B：庄家的对家(座2)发起，把主牌交给庄家
{
  const s = baseState(0);
  playerBySeat(s,2).hand = [C('t1','H',3),C('t2','H',4),C('t3','H',5)];
  playerBySeat(s,0).hand = [C('x1','S',3),C('x2','S',4),C('x3','S',5)];
  const active = { fromSeat:2, toSeat:0, giveCardIds:['t1','t2','t3'], deadline:0 };
  s.round.crossRiver.active.push(active);
  executeCrossRiver(s, active, ['x1','x2','x3']);
  check('§6.12','庄家对家发起(庄家只是收牌) → declarerCrossedRiver=false', s.round.declarerCrossedRiver, false);
}
// 情形 C：闲家队发起，与庄家无关
{
  const s = baseState(0);
  playerBySeat(s,1).hand = [C('t1','H',3),C('t2','H',4),C('t3','H',5)];
  playerBySeat(s,3).hand = [C('x1','S',3),C('x2','S',4),C('x3','S',5)];
  const active = { fromSeat:1, toSeat:3, giveCardIds:['t1','t2','t3'], deadline:0 };
  s.round.crossRiver.active.push(active);
  executeCrossRiver(s, active, ['x1','x2','x3']);
  check('§6.12','闲家队过河 → declarerCrossedRiver=false', s.round.declarerCrossedRiver, false);
}
// 惩罚计算
check('§6.9-4','【新规则】庄家触发过河+撬底+底牌8张主 → 正常1级+8=9级',
  settleRound({defenderTrickPoints:90,kittyPoints:0,kittyGrab:true,declarerTeam:0,declarerCrossedRiver:true,trumpsInKitty:8}).upgradeCount, 9);
check('§6.9-4','文档原例:P_final=90该升0级+8张主 → 8级',
  settleRound({defenderTrickPoints:90,kittyPoints:0,kittyGrab:true,declarerTeam:0,declarerCrossedRiver:true,trumpsInKitty:8}).defenderPoints, 90);
check('§6.12','未触发过河 → 埋主牌进底不受罚（惩罚为 0，只剩撬底本身的 1 级）',
  (()=>{const r=settleRound({defenderTrickPoints:90,kittyPoints:0,kittyGrab:true,declarerTeam:0,declarerCrossedRiver:false,trumpsInKitty:8});return [r.crossRiverPenalty, r.upgradeCount];})(), [0,1]);
check('§6.12','触发过河但未被撬底 → 不罚',
  settleRound({defenderTrickPoints:50,kittyPoints:0,kittyGrab:false,declarerTeam:0,declarerCrossedRiver:true,trumpsInKitty:8}).upgradeCount, 2);
check('§6.9-4','【新规则】P_final=120 该升3级 + 8张主 → 11级',
  settleRound({defenderTrickPoints:100,kittyPoints:20,kittyGrab:true,declarerTeam:0,declarerCrossedRiver:true,trumpsInKitty:8}).upgradeCount, 11);

// ---- 撬底判定：两条提前结束路径 ----
function stateWithLastTrick(declarerSeat, winnerSeat) {
  const s = baseState(declarerSeat);
  s.round.trickHistory = [{ trickNo:1, winnerSeat }];
  return s;
}
check('§6.9','最后一轮闲家赢 → 撬底', kittyGrabOf(stateWithLastTrick(0, 1)), true);
check('§6.9','最后一轮庄家方赢 → 不撬底', kittyGrabOf(stateWithLastTrick(0, 2)), false);
check('§6.7.1','碾压:虚拟轮赢家为闲家方 → 撬底', kittyGrabOf(stateWithLastTrick(0, 3)), true);

// ---- §6.4.0-9 亮主一次性，不能反主 ----
{
  const s = createInitialState(() => 0.5);
  s.phase='REVEALING'; s.declarerSeat=null;
  const r = createRoundState(1,null); r.rankCard=2; r.trumpSuit=null; r.drawnCount=10;
  s.round=r;
  for (const p of s.players) p.connected=true;
  playerBySeat(s,0).hand=[C('h2','H',2)];
  playerBySeat(s,1).hand=[C('s2','S',2)];
  const first = applyAction(s,{type:'declareTrump',cardId:'h2'}, playerBySeat(s,0).id);
  const second = applyAction(s,{type:'declareTrump',cardId:'s2'}, playerBySeat(s,1).id);
  check('§10-21','先亮者生效', [first.ok, s.round.trumpSuit], [true,'H']);
  check('§10-21','反主被拒（拒绝本身成立）', second.ok, false);
  check('§10-41','⚠️后到者应收到 TRUMP_ALREADY_DECLARED', second.error.code, 'TRUMP_ALREADY_DECLARED');
  // 真实客户端会带上自己以为的 phase，走 STALE_STATE 分支
  const s3 = applyAction(s,{type:'declareTrump',cardId:'s2',phase:'REVEALING'}, playerBySeat(s,1).id);
  check('§10-41','⚠️带 phase 的真实客户端拿到的码', s3.error.code, 'TRUMP_ALREADY_DECLARED');
  check('§10-41','主牌以先到者为准', s.round.trumpSuit, 'H');
  check('§10-11','第一局亮牌者即庄家', s.declarerSeat, 0);
}
// ---- §6.4.0-11 第二局起：闲家亮主不改变庄家 ----
{
  const s = createInitialState(() => 0.5);
  s.phase='REVEALING'; s.declarerSeat=0;   // 庄家已由轮转确定为座0
  const r = createRoundState(2,0); r.rankCard=2; r.trumpSuit=null; r.drawnCount=10;
  s.round=r;
  for (const p of s.players) p.connected=true;
  const defender = playerBySeat(s,1);      // 闲家
  defender.hand=[C('s2','S',2)];
  const res = applyAction(s,{type:'declareTrump',cardId:'s2'}, defender.id);
  check('§10-34','闲家亮主成功且主牌变♠', [res.ok, s.round.trumpSuit], [true,'S']);
  check('§10-34','庄家不变(仍是座0)', s.declarerSeat, 0);
}

console.log(`\n流程级核对：${pass} 通过，${fail} 不符\n`);
if (fails.length) { console.log('不符项：'); for (const f of fails) console.log('  ✗ ' + f); }
