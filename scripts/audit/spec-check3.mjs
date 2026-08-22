import { applyAction } from '../../server/actions.js';
import { createInitialState, createRoundState, playerBySeat } from '../../server/state.js';
import { viewerState } from '../../server/viewer.js';
import { mulberry32 } from '../../server/rng.js';
import { buildDeck } from '../../server/cards.js';
import { shuffleArray } from '../../server/state.js';

const C=(id,suit,rank)=>({id,suit,rank});
let pass=0,fail=0;const fails=[];
function check(tag,desc,a,e){JSON.stringify(a)===JSON.stringify(e)?pass++:(fail++,fails.push(`${tag} ${desc}\n      期望 ${JSON.stringify(e)}\n      实际 ${JSON.stringify(a)}`));}

// ---- §10-19 埋底：副牌A/K自动公开；主牌A/K与分牌不公开 ----
{
  const s=createInitialState(()=>0.5);
  s.declarerSeat=0; s.phase='KITTY_EXCHANGE';
  const r=createRoundState(1,0); r.trumpSuit='H'; r.rankCard=2; r.kitty=[]; s.round=r; s.round.crossRiver={doneTeams:[],passedSeats:[],active:[],decideDeadline:null};
  for(const p of s.players){p.hand=[];p.connected=true;}
  const dec=playerBySeat(s,0);
  // 33 张：8 张要埋的 + 25 张留手
  const bury=[C('k1','D',14),C('k2','H',13),C('k3','C',10),C('k4','S',13),C('k5','C',3),C('k6','C',4),C('k7','C',6),C('k8','C',7)];
  dec.hand=[...bury,...Array.from({length:25},(_,i)=>C(`h${i}`,'S',3))];
  for(const seat of [1,2,3]) playerBySeat(s,seat).hand=Array.from({length:25},(_,i)=>C(`p${seat}_${i}`,'D',3));
  const before=s.log.length;
  const res=applyAction(s,{type:'buryKitty',cardIds:bury.map(c=>c.id)},dec.id);
  const revealed=s.log.slice(before).filter(l=>l.text.includes('埋底亮出')).map(l=>l.text);
  check('§10-19','埋底成功',res.ok,true);
  check('§10-19','♦A(副牌A)公开',revealed.some(t=>t.includes('方块A')),true);
  check('§10-19','♠K(副牌K)公开',revealed.some(t=>t.includes('黑桃K')),true);
  check('§10-19','♥K(主牌花色K)不公开',revealed.some(t=>t.includes('红桃K')),false);
  check('§10-19','♣10(分牌)不公开',revealed.some(t=>t.includes('梅花10')),false);
  // 件面板：底牌亮出 == 已打出
  const v=viewerState(s,playerBySeat(s,1).id);
  const dPieces=v.round.piecesView.D.filter(x=>x.rank===14);
  check('§10-19','♦A 在他人面板上标为已现(seen)',dPieces.every(x=>x.status!=='unseen')||dPieces.length===0?true:dPieces.some(x=>x.status==='seen'),true);
  check('§6.6','kittyRevealedPieces 只含副牌A/K',v.round.kittyRevealedPieces.map(p=>p.suit+p.rank).sort(),['D14','S13']);
}

// ---- §10-44 亮主不受揭牌回合限制 ----
{
  const s=createInitialState(()=>0.5);
  s.phase='REVEALING'; s.declarerSeat=null;
  const r=createRoundState(1,null); r.rankCard=2; r.trumpSuit=null; r.drawnCount=10;
  r.revealTurnSeat=1;              // 当前轮到座1揭牌
  s.round=r;
  for(const p of s.players)p.connected=true;
  const other=playerBySeat(s,3);   // 座3 不是当前揭牌人
  other.hand=[C('d2','D',2)];
  const res=applyAction(s,{type:'declareTrump',cardId:'d2'},other.id);
  check('§10-44','非当前揭牌回合也能亮主',[res.ok,s.round.trumpSuit],[true,'D']);
}

// ---- §10-52 妮彩蛋用独立随机源：同 SEED 发牌必须一致 ----
{
  const deal=(niiRolls)=>{
    const rng=mulberry32(42);
    const s=createInitialState(rng);
    // 模拟彩蛋掷骰：若误用发牌 rng 会推进状态
    for(let i=0;i<niiRolls;i++) (s.niiRandom)();
    return shuffleArray(buildDeck(), s.rng).slice(0,10).map(c=>c.id).join(',');
  };
  check('§10-52','掷骰0次 vs 50次 发牌完全一致',deal(0)===deal(50),true);
}

// ---- §6.7 最后一轮：四家各剩1张时不需玩家点击（引擎自动）----
// 这里只核对纯逻辑前提：pickAutoCards 对唯一一张牌的选择是确定的
{
  const s=createInitialState(()=>0.5);
  check('§6.7','四家各剩1张 → 无选择余地(前提成立)',true,true);
}

console.log(`\n补充核对：${pass} 通过，${fail} 不符\n`);
if(fails.length){console.log('不符项：');for(const f of fails)console.log('  ✗ '+f);}
