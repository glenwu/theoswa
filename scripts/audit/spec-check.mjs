// 审计脚本（不进主干）：把文档 §10 的验收用例逐条跑一遍。
// 只读，不修改任何实现。
import { cardStrength, compareCards, playSuitOf } from '../../server/cards.js';
import { validateLeadPlay, validateFollowPlay, trickLeader } from '../../server/trick.js';
import { settleRound, nextDeclarerSeat, kittyGrabOf, checkConservation } from '../../server/scoring.js';
import { applyUpgrades, rankOfLevel, isVictory } from '../../server/level.js';
import { trumpDumpVerdict, isPieceCard, canThrowByStatus } from '../../server/pieces.js';
import { fallbackTrumpOf, starterFromFlip } from '../../server/reveal.js';
import { nextSeat, oppositeSeat, seatOrderFrom } from '../../server/rotation.js';

const C = (id, suit, rank) => ({ id, suit, rank });
const HEART2 = { trumpSuit: 'H', rankCard: 2 };

let pass = 0, fail = 0;
const fails = [];
function check(no, desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; fails.push(`§10-${no} ${desc}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
}
function checkOk(no, desc, cond) { check(no, desc, !!cond, true); }

// 1. 主2 > 副2；两张副2 先出者大
check(1, '主2 > 副2', compareCards(C('a','H',2), C('b','S',2), HEART2), 1);
check(1, '两张副2 同强度(先出者大)', compareCards(C('a','S',2), C('b','D',2), HEART2), 0);
// 2. 大王 > 小王 > 主2
check(2, '大王>小王', compareCards(C('a','JOKER',16), C('b','JOKER',15), HEART2), 1);
check(2, '小王>主2', compareCards(C('a','JOKER',15), C('b','H',2), HEART2), 1);

// 3/4/25. 跟牌
// 注意：主=♥ 时 ♥ 属主牌，跟牌测试一律用副牌花色
const handS = [C('s1','S',3), C('s2','S',4), C('c1','C',9)];
check(3, '副牌:有该花色必须跟', validateFollowPlay({hand:handS,leadSuit:'S',leadCount:1,...HEART2},['c1']).ok, false);
check(4, '我2张♠ 首家甩3张♠ → 必须全出+补1', validateFollowPlay({hand:handS,leadSuit:'S',leadCount:3,...HEART2},['s1','s2','c1']).ok, true);
check(4, '我2张♠ 留一张不出 → 拒绝', validateFollowPlay({hand:[...handS,C('c2','C',5)],leadSuit:'S',leadCount:3,...HEART2},['s1','c1','c2']).ok, false);
const hand5S = [1,2,3,4,5].map(i=>C(`s${i}`,'S',i+2));
check(25, '我5张♠ 首家甩3 → 自选3张', validateFollowPlay({hand:hand5S,leadSuit:'S',leadCount:3,...HEART2},['s1','s3','s5']).ok, true);

// 5/11/12/13/6/7. 计分表
check(5, '【新规则】底牌K+5=15，撬底 → P=15（不再+20）', settleRound({defenderTrickPoints:0,kittyPoints:15,kittyGrab:true,declarerTeam:0}).defenderPoints, 15);
check(6, '闲家0分 → 庄家升5级且连庄', [settleRound({defenderTrickPoints:0,kittyPoints:0,kittyGrab:false,declarerTeam:0}).upgradeCount,
  settleRound({defenderTrickPoints:0,kittyPoints:0,kittyGrab:false,declarerTeam:0}).transfer], [5,false]);
check(7, '闲家105 → 移庄+闲家升1', [settleRound({defenderTrickPoints:105,kittyPoints:0,kittyGrab:false,declarerTeam:0}).upgradeCount,
  settleRound({defenderTrickPoints:105,kittyPoints:0,kittyGrab:false,declarerTeam:0}).transfer], [1,true]);
// §10-11/13 已被 Glen 2026-08-20 的规则变更覆盖：撬底且≥80 档位整体 +1 级
check(11, '【新规则】台面80撬底 → P=80，移庄升1级', (()=>{const r=settleRound({defenderTrickPoints:80,kittyPoints:0,kittyGrab:true,declarerTeam:0});return [r.defenderPoints,r.transfer,r.upgradeCount];})(), [80,true,1]);
check(12, '台面50撬底 → 移庄双方不升级(庄家不得升2级)', (()=>{const r=settleRound({defenderTrickPoints:50,kittyPoints:0,kittyGrab:true,declarerTeam:0});return [r.defenderPoints,r.transfer,r.upgradeCount];})(), [50,true,0]);
check(13, '【新规则】台面100撬底 → 移庄闲家升2', (()=>{const r=settleRound({defenderTrickPoints:100,kittyPoints:0,kittyGrab:true,declarerTeam:0});return [r.defenderPoints,r.transfer,r.upgradeCount];})(), [100,true,2]);
check('新档位', '撬底逐档 80/100/120/140/160/180/200 → 1..7 级', [80,100,120,140,160,180,200].map(P=>settleRound({defenderTrickPoints:P,kittyPoints:0,kittyGrab:true,declarerTeam:0}).upgradeCount), [1,2,3,4,5,6,7]);
// 连庄档位全表
for (const [p, lv] of [[0,5],[1,4],[19,4],[20,3],[39,3],[40,2],[59,2],[60,1],[79,1]]) {
  check('6表', `P=${p} → 庄家升${lv}级`, settleRound({defenderTrickPoints:p,kittyPoints:0,kittyGrab:false,declarerTeam:0}).upgradeCount, lv);
}
for (const [p, lv] of [[80,0],[99,0],[100,1],[119,1],[120,2],[139,2],[140,3]]) {
  check('6表', `P=${p} → 闲家升${lv}级`, settleRound({defenderTrickPoints:p,kittyPoints:0,kittyGrab:false,declarerTeam:0}).upgradeCount, lv);
}

// 8/24. 守恒
check(8, '守恒 100+80+20=200', checkConservation(100,80,20), true);
check(24, '守恒失败可检出', checkConservation(100,80,10), false);

// 9. 两张相同牌 先出者大
check(9, '两张♥7 同强度', compareCards(C('a','H',7), C('b','H',7), HEART2), 0);

// 20/25/26. 轮转
check(20, '逆时针 0→3→2→1', seatOrderFrom(0), [0,3,2,1]);
check(25, '连庄 → 对家(座位+2)', nextDeclarerSeat(0,false), 2);
check(26, '移庄 → 下家(逆时针)', nextDeclarerSeat(0,true), 3);

// 27/28/29. 级别绕回
check(27, 'levelIndex12升1→13,级牌回2,不获胜', (()=>{const r=applyUpgrades([12,0],0,1);return [r.levels[0], rankOfLevel(r.levels[0]), r.winningTeam];})(), [13,2,null]);
check(28, 'levelIndex13升1→14 获胜', (()=>{const r=applyUpgrades([13,0],0,1);return [r.levels[0], r.winningTeam];})(), [14,0]);
check(29, 'levelIndex11升3→14 当场获胜', (()=>{const r=applyUpgrades([11,0],0,3);return [r.levels[0], r.winningTeam];})(), [14,0]);
check('6.10', 'levelIndex12 级牌=A', rankOfLevel(12), 14);

// 31/32. 揭底定主
check(31, '底牌[大王,♦9,♠K,♣2] 打2 → 主♣', fallbackTrumpOf([C('a','JOKER',16),C('b','D',9),C('c','S',13),C('d','C',2)],2).trumpSuit, 'C');
check(32, '底牌[小王,♥7,..] 无级牌 → 主♥', fallbackTrumpOf([C('a','JOKER',15),C('b','H',7),C('c','S',9)],2).trumpSuit, 'H');

// 22. 翻牌定起揭人 n%4 相对翻牌人
check(22, 'A(=1) → 翻牌人自己', starterFromFlip(14, 1), 1);
check(22, '点数2 → 下家', starterFromFlip(2, 1), nextSeat(1));
check(22, '点数3 → 对家', starterFromFlip(3, 1), oppositeSeat(1));
check(22, '点数4(n%4=0) → 上家', starterFromFlip(4, 1), (1+1)%4);

// 35/36/37. 杀
const leadThrow3H = { seat:0, cards:[C('l1','S',5),C('l2','S',6),C('l3','S',7)], playSuit:'S' };
check(35, '出满3张主牌=杀', trickLeader([leadThrow3H, {seat:3,cards:[C('t1','H',5),C('t2','H',7),C('t3','H',9)]}], HEART2).seat, 3);
check(36, '2主+1杂 不算杀', trickLeader([leadThrow3H, {seat:3,cards:[C('t1','H',5),C('t2','H',7),C('t3','C',9)]}], HEART2).seat, 0);
check(37, '两家都杀 比最大一张', trickLeader([leadThrow3H,
  {seat:3,cards:[C('t1','H',5),C('t2','H',7),C('t3','H',9)]},
  {seat:2,cards:[C('u1','H',10),C('u2','H',11),C('u3','H',12)]}], HEART2).seat, 2);

// 14/15/16/18. 副牌件甩牌
const items3mine1unseen = [{rank:14,status:'mine'},{rank:14,status:'mine'},{rank:13,status:'mine'},{rank:13,status:'unseen'}];
check(14, '♠A♠A♠K在手,第四件♠K未现 → 拒绝', canThrowByStatus(items3mine1unseen), false);
check(15, '♠K被打出后 → 获准', canThrowByStatus(items3mine1unseen.map(x=>x.status==='unseen'?{...x,status:'seen'}:x)), true);
check(16, '四件全已打出,自己一件没有 → 四家都可甩', canThrowByStatus([{rank:14,status:'seen'},{rank:14,status:'seen'},{rank:13,status:'seen'},{rank:13,status:'seen'}]), true);
check(18, '打A局:一张♠K在手,另一张未现 → 拒绝', canThrowByStatus([{rank:13,status:'mine'},{rank:13,status:'unseen'}]), false);
// 件定义
check('6.8.1', '打A时 A不是件、K是件', [isPieceCard(C('a','S',14),'H',14), isPieceCard(C('b','S',13),'H',14)], [false,true]);
check('6.8.1', '打K时 K不是件、A是件', [isPieceCard(C('a','S',13),'H',13), isPieceCard(C('b','S',14),'H',13)], [false,true]);
check('6.8.1', '主牌花色A/K不是件', isPieceCard(C('a','H',14),'H',2), false);

// 47/48/49/50. 主牌甩牌
const sixTrumps = [C('j1','JOKER',16),C('j2','JOKER',16),C('j3','JOKER',15),C('j4','JOKER',15),C('r1','H',2),C('r2','H',2)];
const tbl = (entries) => entries.map(([suit,rank,kind,seat])=>({cardId:`${suit}${rank}${seat??''}`,suit,rank,location:seat!==undefined?{kind,seat}:{kind}}));
check(47, '4鬼+2主2 全在手 → 甩6张成立', trumpDumpVerdict({trumpCards:tbl([['JOKER',16,'hand',0],['JOKER',16,'hand',0],['JOKER',15,'hand',0],['JOKER',15,'hand',0],['H',2,'hand',0],['H',2,'hand',0]]),mySeat:0,...HEART2}, sixTrumps).eligible, true);
check(48, '少一张小鬼且未露面 → 不成立', trumpDumpVerdict({trumpCards:tbl([['JOKER',16,'hand',0],['JOKER',16,'hand',0],['JOKER',15,'hand',0],['JOKER',15,'hand',1],['H',2,'hand',0],['H',2,'hand',0]]),mySeat:0,...HEART2}, sixTrumps.slice(0,3).concat(sixTrumps.slice(4))).eligible, false);
check(49, '那张小鬼已被打出 → 成立', trumpDumpVerdict({trumpCards:tbl([['JOKER',16,'hand',0],['JOKER',16,'hand',0],['JOKER',15,'hand',0],['JOKER',15,'played'],['H',2,'hand',0],['H',2,'hand',0]]),mySeat:0,...HEART2}, sixTrumps.slice(0,3).concat(sixTrumps.slice(4))).eligible, true);
check(50, '最小是副级牌,别人有另一门副级牌(平手) → 成立', trumpDumpVerdict({trumpCards:tbl([['S',2,'hand',0],['D',2,'hand',1]]),mySeat:0,...HEART2}, [C('s2','S',2)]).eligible, true);
check('6.8.2b', '底牌里的大主牌不挡(已出局)', trumpDumpVerdict({trumpCards:tbl([['JOKER',16,'kitty'],['H',2,'hand',0]]),mySeat:0,...HEART2}, [C('r','H',2)]).eligible, true);

// 10. 不构成合法甩牌 → 拒绝
check(10, '两张不同花色当甩牌 → 拒绝', validateLeadPlay({hand:[C('a','S',5),C('b','C',6)],piecesView:{S:[],C:[],D:[]},...HEART2},['a','b']).ok, false);
// 主牌甩牌首家一律放行（资格由服务端事后裁决）
check('6.8.2b', '主牌甩牌首家放行(不提前拒绝)', validateLeadPlay({hand:[C('a','H',5),C('b','H',6)],piecesView:{S:[],C:[],D:[]},...HEART2},['a','b']).kind, 'trumpThrow');

console.log(`\n验收用例核对：${pass} 通过，${fail} 不符\n`);
if (fails.length) { console.log('不符项：'); for (const f of fails) console.log('  ✗ ' + f); }
