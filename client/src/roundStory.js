// 本局复盘叙述（纯函数，无 DOM）：把 RoundSummary + 逐轮记录讲成几句人话。
// 只用公开信息（局末四家手牌已出尽，trickHistory 全公开），不涉及任何保密数据。

const TEAM = ['金队', '青队'];

// 抓分轮次：赢家是闲家方且这一轮有分
function pointTricks(trickHistory, declarerSeat) {
  return (trickHistory ?? []).filter(
    t => t.points > 0 && t.winnerSeat % 2 !== declarerSeat % 2
  );
}

// 庄家方赢下并作废的有分轮次
function runAwayTricks(trickHistory, declarerSeat) {
  return (trickHistory ?? []).filter(
    t => t.points > 0 && t.winnerSeat % 2 === declarerSeat % 2
  );
}

// 返回 string[]：每条一句，按「怎么打的 → 结果为什么是这样」排列。
// nameBySeat: (seat) => 昵称
export function roundStory(summary, trickHistory, nameBySeat) {
  if (!summary) return [];
  const name = seat => nameBySeat?.(seat) ?? `座位${seat}`;
  const declarerSeat = summary.declarerSeat;
  const defenderTeam = 1 - (declarerSeat % 2);
  const lines = [];

  const grabbed = pointTricks(trickHistory, declarerSeat);
  const ran = runAwayTricks(trickHistory, declarerSeat);

  // 1) 闲家抓分从哪来
  if (grabbed.length === 0) {
    lines.push(`${TEAM[defenderTeam]}（闲家）一分未抓，${summary.defenderTrickPoints === 0 ? '被剃了光头' : '台面全靠底牌'}。`);
  } else {
    const biggest = grabbed.reduce((a, b) => (b.points > a.points ? b : a));
    lines.push(
      `${TEAM[defenderTeam]}（闲家）在 ${grabbed.length} 轮里抓到台面 ${summary.defenderTrickPoints} 分，` +
        `最大的一手是第 ${biggest.trickNo} 轮的 ${biggest.points} 分（${name(biggest.winnerSeat)} 拿下）。`
    );
  }

  // 2) 庄家把多少分做掉了
  if (summary.runAwayPoints > 0) {
    lines.push(
      `庄家方赢下 ${ran.length} 轮带分的，共 ${summary.runAwayPoints} 分直接作废跑掉。`
    );
  }

  // 3) 最后一轮定撬底
  const last = (trickHistory ?? [])[trickHistory.length - 1];
  if (last) {
    const who = name(last.winnerSeat);
    lines.push(
      summary.kittyGrab
        ? `最后一轮被 ${who}（闲家方）拿下 —— 撬底成立，底牌 ${summary.kittyPoints} 分计入闲家，另加 20 分。`
        : `最后一轮由 ${who}（庄家方）守住 —— 底牌 ${summary.kittyPoints} 分跟着跑掉，没被撬。`
    );
  }

  // 4) 三主过河惩罚（只有庄家触发过河且被撬底才会有）
  if (summary.crossRiverPenalty > 0) {
    lines.push(
      `庄家本局触发了三主过河又被撬底，底牌里 ${summary.crossRiverPenalty} 张主牌，闲家额外多升 ${summary.crossRiverPenalty} 级。`
    );
  }

  // 5) 结论
  const upgrade =
    summary.upgradeCount > 0
      ? `${TEAM[summary.upgradedTeam]}升 ${summary.upgradeCount} 级`
      : '双方都不升级';
  lines.push(
    `最终闲家 P=${summary.defenderPoints}，${summary.transfer ? '移庄' : '连庄'}，${upgrade}。`
  );

  return lines;
}
