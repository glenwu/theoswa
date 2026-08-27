import { Fragment, useEffect, useRef, useState } from 'react';
import { levelLabel, rankLabel, suitSymbol, suitRed, PLAYER_EMOJI, TEAM_COLORS } from '../utils.js';
import { useNow, secondsLeft, displayNow } from '../useNow.js';
import { playedCounts, totalCounts } from '../playedCounts.js';
import { seatStatusText } from '../seatStatus.js';
import { THEMES, applyTheme, loadTheme } from '../theme.js';
import { canThrowByStatus } from '../../../server/pieces.js';
import { beep } from '../beep.js';
import Modal from './Modal.jsx';
import { ProposeResetModal, ForceResetModal } from './ResetModals.jsx';

// 左栏：玩家列表。自己固定排第一行并显著标注，其余三人从自己往下按逆时针排：
// 我 → 下家 → 对家 → 上家。自己的卡片下挂手牌构成 + 件追踪面板（只显示自己的）。
export default function PlayerPanel({ game, send }) {
  const [modal, setModal] = useState(null);
  const [showPropose, setShowPropose] = useState(false);
  const [showForce, setShowForce] = useState(false);
  const you = game.you;
  const order = [you.seat, (you.seat + 3) % 4, (you.seat + 2) % 4, (you.seat + 1) % 4];
  const bySeat = Object.fromEntries(game.players.map(p => [p.seat, p]));

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="border-b border-white/10 p-3 text-center">
        <div className="text-lg font-black text-amber-300">潮汕升级</div>
        <div className="text-xs font-bold text-white/50">两副牌 · 四人两队</div>
        {(game.phase === 'SEATING' || game.phase === 'READY_CHECK') && (
          <div className="mt-1 text-[11px] font-bold text-cyan-200/70">
            点击掉线位置添加电脑；点击电脑可移除
          </div>
        )}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {order.map((seat, i) => (
          <Fragment key={seat}>
            <PlayerCard
              player={bySeat[seat]}
              isYou={seat === you.seat}
              game={game}
              send={send}
            />
            {seat === you.seat && <MyDetails game={game} />}
            {i === 1 && <VsBadge game={game} />}
          </Fragment>
        ))}
      </div>

      <div className="flex flex-wrap justify-center gap-2 border-t border-white/10 p-2">
        <button className="btn-icon" title="规则说明" onClick={() => setModal('rules')}>📖</button>
        <button className="btn-icon" title="本局历史" onClick={() => setModal('history')}>🕘</button>
        <button className="btn-icon" title="配色方案" onClick={() => setModal('theme')}>🎨</button>
        <button
          className="btn-icon"
          title={game.resetProposal ? '新开一局提案进行中' : '提议新开一局'}
          onClick={() => setShowPropose(true)}
        >
          🔄
        </button>
        <button
          className="btn-icon"
          title={game.paused ? '游戏已暂停' : '暂停游戏（所有倒计时一起停住）'}
          disabled={!!game.paused}
          onClick={() => send({ type: 'pause' })}
        >
          ⏸
        </button>
        {you.isAdmin && (
          <button
            className="btn-icon !bg-rose-500/30"
            title="强制重置（跳过全员同意）"
            onClick={() => setShowForce(true)}
          >
            ⛔
          </button>
        )}
      </div>

      {modal === 'rules' && <RulesModal onClose={() => setModal(null)} />}
      {modal === 'history' && <HistoryModal game={game} onClose={() => setModal(null)} />}
      {modal === 'theme' && <ThemeModal onClose={() => setModal(null)} />}
      {showPropose && !game.resetProposal && (
        <ProposeResetModal game={game} send={send} onClose={() => setShowPropose(false)} />
      )}
      {showForce && <ForceResetModal game={game} send={send} onClose={() => setShowForce(false)} />}
    </div>
  );
}

// 规则说明：重点讲清四件容易懵的事
function RulesModal({ onClose }) {
  return (
    <Modal title="规则说明" onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto text-sm leading-6 text-white/80">
        <section className="rounded-xl bg-white/5 p-3">
          <h3 className="font-black text-amber-300">① 主牌大小顺序</h3>
          <p className="mt-1">
            大鬼 ＞ 小鬼 ＞ 主级牌（主花色该点数）＞ 副级牌（其他花色该点数）＞ 主花色 A→3。
            副级牌之间不分大小，先出者大；主牌花色的所有牌都是主牌。
          </p>
        </section>
        <section className="rounded-xl bg-white/5 p-3">
          <h3 className="font-black text-amber-300">② 甩牌资格：副牌看「件」，主牌自己算</h3>
          <p className="mt-1">
            件 = 某副牌花色的 A 和 K（打 A 时只有 K 是件，打 K 时只有 A 是件）。
            该花色的每一件都在你手上、已被打出、或被埋底亮出时，你才能甩这个花色；
            否则只能单张出。左栏自己卡片下的件追踪面板实时显示每件的去向（我 / 现 / 未），
            显示「可甩」才甩得了。
          </p>
          <p className="mt-1">
            主牌也可以甩：资格看你甩出的<b>最小那张</b>——比它大的主牌若全部已打出、在你手上
            或在底牌里（不在其他三家暗牌），甩牌成立；算错了只打出最小那一张、其余收回，
            没有额外罚分。面板不给主牌提示，全靠自己心算。
          </p>
        </section>
        <section className="rounded-xl bg-white/5 p-3">
          <h3 className="font-black text-amber-300">③ 三主过河</h3>
          <p className="mt-1">
            换底后、出牌前：主牌 ≤3 张的人可以过河——把全部主牌（副牌补足 3 张）交给对家，
            换回对家 3 张副牌。每队每局最多一次，先点先得；对家 30 秒不选自动给最小 3 副。
            庄家过河且被撬底时，底牌每张主牌让闲家额外 +1 级。
          </p>
        </section>
        <section className="rounded-xl bg-white/5 p-3">
          <h3 className="font-black text-amber-300">④ 庄家不吃分，是跑分</h3>
          <p className="mt-1">
            只有闲家一个分数账。闲家赢下的一轮，分牌计入闲家；庄家赢下的分直接作废跑掉，
            不进任何一方。全局 200 分守恒：闲家 + 跑掉 + 底牌 = 200。
          </p>
        </section>
        <section className="rounded-xl bg-white/5 p-3">
          <h3 className="font-black text-amber-300">⑤ 级别绕回 2</h3>
          <p className="mt-1">
            打 A 之后再升一级回到 2（第二圈），在第二圈的 2 上再升一级才算获胜——
            一支队伍从 2 打起共要跨 14 级。第二圈的 2 打牌时与普通 2 完全一样。
            闲家抓够 80 分移庄；撬底无条件移庄，底牌分计入闲家，且升级档位比守成时整体高一级。
          </p>
        </section>
      </div>
    </Modal>
  );
}

// 本局历史：RoundSummary 列表，每行一局
function HistoryModal({ game, onClose }) {
  const rounds = game.rounds ?? [];
  return (
    <Modal title="本局历史" onClose={onClose}>
      {rounds.length === 0 ? (
        <p className="text-sm text-white/60">暂无对局记录。</p>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {rounds.map(s => {
            const declarer = game.players.find(p => p.seat === s.declarerSeat);
            const next = game.players.find(p => p.seat === s.nextDeclarerSeat);
            return (
              <div key={s.roundNumber} className="rounded-xl bg-white/5 p-2.5 text-xs font-bold text-white/80">
                <div className="flex items-center justify-between">
                  <span className="font-black text-amber-300">
                    第 {s.roundNumber} 局 · {declarer?.nickname} 做庄 · 主{suitSymbol(s.trumpSuit)}打 {rankLabel(s.rankCard)}
                  </span>
                  <span className="pill bg-white/10 text-white/70">{s.transfer ? '移庄' : '连庄'}</span>
                </div>
                <div className="mt-1 text-white/60">
                  闲家 {s.defenderTrickPoints} · 跑掉 {s.runAwayPoints} · 底牌 {s.kittyPoints}
                  {s.kittyGrab ? ' · 撬底' : ''}
                  {' → P='}{s.defenderPoints}
                </div>
                <div className="mt-0.5">
                  {s.upgradeCount > 0
                    ? `${s.upgradedTeam === 0 ? '金队' : '青队'}升 ${s.upgradeCount} 级`
                    : '双方不升级'}
                  {' · 下一局 '}{next?.nickname} 做庄 · 打 {levelLabel(game.teamLevels[s.nextDeclarerSeat % 2])}
                  {s.conservationOk ? '' : ' ⚠️守恒异常'}
                </div>
                {s.botReview && (
                  <details className="mt-2 rounded-lg bg-cyan-400/10 px-2 py-1.5 text-cyan-100/80">
                    <summary className="cursor-pointer font-black text-cyan-200">
                      🤖 AI 复盘：检查 {s.botReview.reviewedPlays} 手
                      {s.botReview.issueCount > 0
                        ? ` · 发现 ${s.botReview.issueCount} 个可改进选择`
                        : ' · 未发现明显劣选'}
                    </summary>
                    {s.botReview.learning && (
                      <div className="mt-1 text-cyan-100/70">
                        共享学习累计 {s.botReview.learning.roundsReviewed} 局、
                        {s.botReview.learning.playsReviewed} 手
                        {s.botReview.learning.dealerBottomRate !== null
                          ? ` · 庄家保底 ${Math.round(s.botReview.learning.dealerBottomRate * 100)}%`
                          : ''}
                        {s.botReview.learning.defenderBottomRate !== null
                          ? ` · 闲家扣底 ${Math.round(s.botReview.learning.defenderBottomRate * 100)}%`
                          : ''}
                      </div>
                    )}
                    {s.botReview.issueCount > 0 && (
                      <>
                        <div className="mt-1 text-cyan-100/60">
                          送件 {s.botReview.counts?.pieceHelp ?? 0} ·
                          冒险送分 {s.botReview.counts?.unsafePoint ?? 0} ·
                          三手漏分 {s.botReview.counts?.lastSeatPoint ?? 0} ·
                          首轮失去主动 {s.botReview.counts?.openingControl ?? 0} ·
                          浪费保底牌 {s.botReview.counts?.controlWaste ?? 0} ·
                          用牌过大 {s.botReview.counts?.overplay ?? 0}
                        </div>
                        <ul className="mt-1 list-disc space-y-1 pl-4">
                          {(s.botReview.examples ?? []).map((example, index) => (
                            <li key={index}>{example}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function VsBadge({ game }) {
  const defenderPoints = game.round?.defenderTrickPoints ?? 0;
  return (
    <div className="flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/5 py-1">
      <span className="font-black text-amber-300">VS</span>
      <span className="text-xs font-bold text-white/60">闲家 {defenderPoints} / 80</span>
    </div>
  );
}

// 状态胶囊：名字下面永远告诉你「这个人到底点没点」。
// 文案判定抽成纯函数放在 seatStatus.js，便于单测 —— 这一块最容易在加了新阶段
// 之后忘了同步，而漏掉的表现就是「四个人干等着，谁也不知道还差谁」。
// 配色方案选择（Glen）。纯本地偏好：存 localStorage，不进牌局状态 ——
// 四个人各挑各的，不该因为谁换了配色就发一条服务端消息。
function ThemeModal({ onClose }) {
  const [current, setCurrent] = useState(loadTheme);
  return (
    <Modal title="配色方案" onClose={onClose}>
      <div className="mb-3 text-xs font-bold text-white/50">
        只换牌桌氛围色，金色的按钮和标记四套一样 —— 那是认路用的。
        选择只存在这台设备上，不影响别人。
      </div>
      <div className="grid grid-cols-2 gap-2">
        {THEMES.map(t => (
          <button
            key={t.id}
            onClick={() => setCurrent(applyTheme(t.id))}
            className={`flex items-center gap-2.5 rounded-2xl border-2 p-2.5 text-left transition ${
              current === t.id
                ? 'border-amber-300 bg-amber-400/10'
                : 'border-white/10 bg-white/5 hover:border-white/25'
            }`}
          >
            <span className="flex shrink-0 flex-col gap-0.5">
              {t.swatch.map(c => (
                <span
                  key={c}
                  className="block h-2.5 w-7 rounded-full"
                  style={{ background: c }}
                />
              ))}
            </span>
            <span className="min-w-0">
              <span className="block font-black text-white">
                {t.name}
                {current === t.id && <span className="ml-1 text-amber-300">✓</span>}
              </span>
              <span className="block truncate text-[11px] font-bold text-white/45">
                {t.desc}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function statusPill(game, player) {
  const text = seatStatusText(game, player);
  if (!text) return null;
  return <span className="pill bg-white/10 text-white/70">{text}</span>;
}

// 我的卡片下挂：手牌构成（只显示自己的！）+ 件追踪面板
function MyDetails({ game }) {
  const comp = game.you.composition;
  if (!comp) return null;
  const round = game.round;
  const trumpSuit = round?.trumpSuit ?? null;
  const suits = ['S', 'H', 'D', 'C'].filter(s => s !== trumpSuit);
  // 第一行从「我自己的手牌构成」改成「场上已经打出来的数量」（Glen）：
  // 自己有几张主自己看得见，反倒是「还剩几张主没出、大鬼走了几张」才需要记，
  // 而且直接决定敢不敢甩、能不能保底。全是公开信息（trickHistory + currentTrick）。
  // 大小鬼本来就算主牌，所以「主」里包含它们，大鬼/小鬼两项是细分。
  const played = playedCounts(round);
  const total = totalCounts(trumpSuit);
  const seen = (label, key, cls) => (
    <span key={key} className={`pill ${cls}`} title={`已打出 ${played[key]} / 共 ${total[key]} 张`}>
      {label} {played[key]}
    </span>
  );
  return (
    <div className="rounded-2xl border-2 border-amber-300/60 bg-amber-400/5 p-2">
      <div className="mb-0.5 text-[10px] font-bold text-white/35">场上已打出</div>
      <div className="mb-1 flex flex-wrap items-center gap-1 text-xs font-bold text-white/80">
        {seen('主', 'trump', 'bg-amber-400/20 text-amber-300')}
        {seen('大鬼', 'bigJoker', 'bg-rose-500/20 text-rose-200')}
        {seen('小鬼', 'smallJoker', 'bg-white/10 text-white/70')}
        {suits.map(s => (
          <span
            key={s}
            className={`pill bg-white/10 ${suitRed(s) ? 'text-rose-300' : 'text-white/70'}`}
            title={`${suitSymbol(s)} 已打出 ${played[s]} / 共 ${total[s]} 张`}
          >
            {suitSymbol(s)}{played[s]}
          </span>
        ))}
      </div>
      {round?.piecesView && (
        <div className="space-y-0.5 text-[11px]">
          {suits.map(suit => {
            const items = round.piecesView[suit] ?? [];
            const canThrow = canThrowByStatus(items);
            return (
              // 能甩的那一门整行高亮（Glen）：这是这块面板唯一「现在就能动手」的信息，
              // 扫一眼就该跳出来，不该和另外两门排成一样的灰。
              <div
                key={suit}
                className={`flex items-center gap-1 rounded ${
                  canThrow ? 'bg-emerald-400/15 px-1 py-px ring-1 ring-emerald-300/45' : ''
                }`}
              >
                <span className={`w-4 shrink-0 text-center font-black ${suitRed(suit) ? 'text-rose-400' : 'text-white/80'}`}>
                  {suitSymbol(suit)}
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap gap-0.5">
                  {items.map((it, i) => (
                    <span
                      key={i}
                      className={`rounded-full px-1.5 py-px font-bold ${
                        it.status === 'mine'
                          ? 'bg-emerald-400/20 text-emerald-300'
                          : it.status === 'seen'
                            ? 'bg-sky-400/20 text-sky-300'
                            : 'bg-white/10 text-white/50'
                      }`}
                    >
                      {rankLabel(it.rank)}·{it.status === 'mine' ? '我' : it.status === 'seen' ? '现' : '未'}
                    </span>
                  ))}
                </div>
                {/* ⚠️ 原来这里不能甩的时候写「还差 缺A、缺K」——【去掉了】（Glen）：
                    左边每一支件本来就用颜色标着状态（绿=我 / 蓝=现 / 灰=未），
                    差哪一支一眼就看得到，右边再用文字重复一遍纯属占地方，
                    而且把三门挤成一样长，反而看不出哪门能甩。
                    现在只在【能甩】时留一个标记，配合整行高亮。 */}
                {canThrow && (
                  <span className="shrink-0 font-black text-emerald-300">可甩</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlayerCard({ player, isYou, game, send }) {
  const colors = TEAM_COLORS[player.team];
  const incoming = game.swapProposals.find(
    sp => sp.toSeat === game.you.seat && sp.fromSeat === player.seat
  );
  const outgoing = game.swapProposals.find(
    sp => sp.fromSeat === game.you.seat && sp.toSeat === player.seat
  );
  // 让电脑接管掉线座位：任何阶段都允许（否则真人接管电脑位后再掉线，
  // 那个座位就永远卡在「掉线」，谁也接不了手）。
  // 移除电脑仍只限开局前：牌局中撤掉电脑会留下一个没人打的空位。
  const inLobby = game.phase === 'SEATING' || game.phase === 'READY_CHECK';
  const canAddBot = !isYou && !player.isBot && !player.connected;
  const canRemoveBot = inLobby && !isYou && player.isBot;
  const canManageBot = canAddBot || canRemoveBot;
  const canSwap =
    game.phase === 'SEATING' && !isYou && !player.seatLocked && !game.you.seatLocked;
  const canInteract = canManageBot || canSwap;

  // 揭牌倒计时：当前揭牌人的卡片上实时显示（3 秒超时由服务端自动摸）
  const revealing =
    game.phase === 'REVEALING' &&
    game.round &&
    game.round.drawnCount < 100 &&
    !game.round.trumpSuit;
  const isDrawer = revealing && game.round.revealTurnSeat === player.seat;
  // 出牌倒计时：当前出牌人卡片上实时显示（60 秒超时由服务端自动出最小牌）
  const playing =
    game.phase === 'PLAYING' && game.round && !game.round.lastTrick && game.round.turnSeat !== null;
  const isPlayTurn = playing && game.round.turnSeat === player.seat;
  const now = displayNow(game, useNow(isDrawer || isPlayTurn));
  const drawLeft = secondsLeft(game.round?.drawDeadline, now);
  const playLeft = secondsLeft(game.round?.playDeadline, now);
  const showTimer = isDrawer ? drawLeft : isPlayTurn ? playLeft : null;
  const timerUrgent = isPlayTurn && playLeft !== null && playLeft <= 10;

  // 最后 10 秒：自己的回合变色 + 轻提示音（只响一次）
  const beepedRef = useRef(false);
  useEffect(() => {
    if (timerUrgent && !beepedRef.current) {
      beepedRef.current = true;
      beep();
    }
    if (!isPlayTurn) beepedRef.current = false;
  }, [timerUrgent, isPlayTurn]);

  function onClick() {
    if (!canInteract) return;
    if (canManageBot) {
      send({ type: player.isBot ? 'removeBot' : 'addBot', playerId: player.id });
      return;
    }
    if (incoming) send({ type: 'acceptSwap', fromSeat: player.seat });
    else send({ type: 'proposeSwap', targetSeat: player.seat });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl border-2 p-2.5 text-left transition ${colors.border} ${
        isYou
          ? 'border-4 border-amber-300 bg-amber-400/15 shadow-lg ring-2 ring-amber-300/50'
          : 'bg-white/5'
      } ${isDrawer ? 'drawer-glow ring-2 ring-amber-300/60' : ''} ${
        canInteract || incoming ? 'cursor-pointer hover:bg-white/15' : 'cursor-default'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-2xl ${colors.bg}`}>
          {PLAYER_EMOJI[player.id]}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-black text-white">
            {/* 自己显著标注：加粗 + （我）后缀 */}
            {/* 「电脑」在名字【前面】（Glen）：和牌桌上的座位保持一致，
                一眼扫过去先看到身份，不用读完名字再找后缀。 */}
            {player.isBot && (
              <span className="pill bg-cyan-400/20 text-cyan-200">🤖 电脑</span>
            )}
            <span className={`truncate ${isYou ? 'text-lg text-amber-200' : ''}`}>
              {player.nickname}
            </span>
            {player.isDeclarer && <span title="庄家">👑</span>}
            {player.isFlipper && <span title="翻牌人">🃏</span>}
            {isYou && <span className="text-sm text-amber-300">（我）</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {/* 托管：放在名字【下边】这一行的最前面，四家都要看得见谁现在是 AI 在打。
                和「🤖 电脑」分开 —— 那个是座位已经没人了，这个是人还在、只是托管了，
                所以用实心底色，比其它状态胶囊更跳眼一点。 */}
            {!player.isBot && player.autoPlay && (
              <span
                className="pill bg-cyan-400/85 font-black text-cyan-950"
                title={`${player.nickname} 已开启电脑托管，由 AI 代打`}
              >
                🤖 托管中
              </span>
            )}
            <span className={`pill ${colors.bg} ${colors.text}`}>
              打 {levelLabel(game.teamLevels[player.team])}
            </span>
            {/* 准备/确认状态只在对应阶段显示；换底/过河换成阶段相关状态，避免误以为卡住 */}
            {statusPill(game, player)}
            {!player.connected && !player.isBot && (
              <span className="pill bg-rose-500/25 text-rose-200">掉线</span>
            )}
            <span className="pill bg-white/10 text-white/70">牌 {player.handCount}</span>
            {/* 倒计时位置：揭牌 3s / 出牌 60s（最后 10 秒变红） */}
            <span
              className={`pill ${
                timerUrgent
                  ? 'bg-rose-500/30 text-rose-200'
                  : showTimer !== null
                    ? 'bg-amber-400/20 text-amber-300'
                    : 'bg-white/5 text-white/30'
              }`}
            >
              {showTimer !== null
                ? isPlayTurn
                  ? `⏱ ${Math.floor(showTimer / 60)}:${String(Math.ceil(showTimer % 60)).padStart(2, '0')}`
                  : `⏱ ${showTimer.toFixed(1)}s`
                : '⏱ —'}
            </span>
          </div>
        </div>
      </div>
      {incoming && (
        <div className="mt-1.5 rounded-full bg-amber-400/20 px-2 py-0.5 text-center text-xs font-black text-amber-300">
          对方想与你换座 → 全屏弹窗确认中
        </div>
      )}
      {outgoing && (
        <div className="mt-1.5 rounded-full bg-amber-400/15 px-2 py-0.5 text-center text-xs font-black text-amber-300">
          已发送换座请求，等待 {player.nickname} 确认……
        </div>
      )}
      {canManageBot && (
        <div className="mt-1.5 rounded-full bg-cyan-400/15 px-2 py-0.5 text-center text-xs font-black text-cyan-200">
          {player.isBot
            ? '点击移除电脑玩家'
            : inLobby ? '点击让电脑加入这个位置' : '点击让电脑接管（手牌继承）'}
        </div>
      )}
    </button>
  );
}
