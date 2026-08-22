import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  suitSymbol,
  suitRed,
  rankLabel,
  cardLabel,
  levelLabel,
  SUIT_INFO,
  PLAYER_EMOJI,
} from '../utils.js';
import { PlayingCard } from './PlayingCard.jsx';
import Modal from './Modal.jsx';
import { useNow, secondsLeft } from '../useNow.js';
import { shortcutAction } from '../shortcut.js';
import { checkSelection } from '../playCheck.js';
import { trickLeader } from '../../../server/trick.js';
import { playSuitOf } from '../../../server/cards.js';
import { tiaoZhuActive } from '../tiaozhu.js';
import { roundStory } from '../roundStory.js';
import { handGroups, groupBadgeCount, partitionByWidth } from '../handGroups.js';
import { tapToggle, dragAdd, toggleGroup } from '../selection.js';
import { ProposeResetModal, ForceResetModal } from './ResetModals.jsx';

const PHASE_NAMES_CN = {
  SEATING: '换座阶段', READY_CHECK: '准备阶段', REVEAL_FIRST: '抢按揭牌',
  REVEALING: '揭牌定主', FALLBACK_TRUMP: '揭底定主', DEALING: '发牌中',
  KITTY_EXCHANGE: '庄家换底', CROSS_RIVER: '三主过河', PLAYING: '出牌',
  DOMINANCE: '碾压收尾', SCORING: '结算', ROUND_END: '本局结束', GAME_OVER: '游戏结束',
};

const PHASE_HINTS = {
  SEATING: '换座阶段：点击左侧玩家请求换座，全员确认座位后开始',
  READY_CHECK: '等待全员准备…',
  REVEAL_FIRST: '抢按「揭牌」成为翻牌人，系统翻牌定起揭人',
  REVEALING: '揭牌定主：轮到你时点「揭牌」（空格），摸到级牌可随时「亮主」（数字键 1~N）',
  FALLBACK_TRUMP: '无人亮主，逐张揭底牌定主…',
  DEALING: '发牌中…',
  KITTY_EXCHANGE: '庄家换底：从 33 张中点选 8 张埋回底牌',
  CROSS_RIVER: '三主过河：主牌 ≤3 张可把主牌交给对家（换回 3 张副牌），不玩可跳过',
  PLAYING: '出牌：点选手牌（可多选甩牌，主牌也可甩——算错只出最小一张），按「出牌」或空格打出',
  SCORING: '结算中…',
  ROUND_END: '本局结束',
  GAME_OVER: '游戏结束',
};

// 手牌牌面档位（宽 px，与 PlayingCard 的尺寸档对应）：放不下时整体降档
const HAND_TIERS = [
  { name: 'lg', w: 56 },
  { name: 'md', w: 44 },
  { name: 'sm', w: 32 },
];

// 手牌固定露出宽度：每张牌只露出左缘这么宽，其余被下一张盖住。
// 18px 刚好容得下“10”+ 花色符号（点数看得清就够）。
// 这是定值，不随视口宽度变化 —— 视口再宽，牌也始终叠在一起、左对齐。
const EXPOSE_W = 18;
// 竖屏窄屏的目标露出宽度：比横屏更宽。竖屏两侧有浮层按钮夹着，手牌行本来就窄，
// 与其把 30 多张挤成一条细缝，不如多占一行、把每张露得更开，手指也更好点。
const PORTRAIT_EXPOSE_W = 26;
// 实在放不下时允许压到的下限，保证绝不横向溢出
const MIN_EXPOSE_W = 8;
// 最多分几行：竖屏可以到 3 行（纵向有的是空间），横屏/桌面最多 2 行
const MAX_ROWS_PORTRAIT = 2;
const MAX_ROWS_WIDE = 2;

// 中栏：十字形四方位牌桌 + 中央信息 + 控制按钮 + 我的手牌
export default function TablePanel({ game, send, error, onTogglePlayers, onToggleChat }) {
  const [selected, setSelected] = useState([]);
  const [declareOptions, setDeclareOptions] = useState(null);

  const you = game.you;
  const bySeat = Object.fromEntries(game.players.map(p => [p.seat, p]));
  const top = bySeat[(you.seat + 2) % 4]; // 对家
  const left = bySeat[(you.seat + 1) % 4]; // 上家
  const right = bySeat[(you.seat + 3) % 4]; // 下家

  // 已打出的牌从选中集清除（出牌成功后保持干净）
  useEffect(() => {
    setSelected(prev => prev.filter(id => (you.hand ?? []).some(c => c.id === id)));
  }, [you.hand]);

  // 阶段切换时立即清空本地选中，防止用旧状态误操作（服务端另有 STALE_STATE 兜底）
  useEffect(() => {
    setSelected([]);
  }, [game.phase]);

  // 选中上限：换底 8 张、三主过河 3 张；出牌甩牌按手牌数量放开
  const selectionCap =
    game.phase === 'KITTY_EXCHANGE'
      ? 8
      : game.phase === 'CROSS_RIVER'
        ? 3
        : Infinity;

  // 单击切换 / 拖动只加选（共用同一份纯逻辑，服务端另有校验兜底）
  function toggleCard(id) {
    setSelected(prev => tapToggle(prev, id, selectionCap));
  }

  function addDragSelection(id) {
    setSelected(prev => dragAdd(prev, id, selectionCap));
  }

  // 点手牌上的组张数角标：整组全选（再点一次取消整组）
  function toggleGroupSelection(ids) {
    setSelected(prev => toggleGroup(prev, ids, selectionCap));
  }

  // 键盘快捷键：空格（揭牌/出牌）、数字 1~N（亮主）。
  // 输入框聚焦时由 shortcut.js 自动失效（打字按空格绝不触发）。
  useEffect(() => {
    const handler = e => {
      const action = shortcutAction(e, {
        phase: game.phase,
        myRevealTurn:
          game.phase === 'REVEALING' &&
          game.round &&
          game.round.drawnCount < 100 &&
          !game.round.trumpSuit &&
          game.round.revealTurnSeat === you.seat,
        myPlayTurn:
          game.phase === 'PLAYING' &&
          game.round &&
          !game.round.lastTrick &&
          game.round.turnSeat === you.seat,
        selectedIds: selected,
        rankCardIds:
          game.phase === 'REVEALING' && game.round
            ? (you.hand ?? []).filter(c => c.rank === game.round.rankCard).map(c => c.id)
            : [],
      });
      if (!action) return;
      if (action.preventDefault) e.preventDefault();
      if (action.type === 'drawCard') send({ type: 'drawCard' });
      else if (action.type === 'play') send({ type: 'play', cardIds: action.cardIds });
      else if (action.type === 'declareTrump') send({ type: 'declareTrump', cardId: action.cardId });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [game, selected, you.seat, send]);

  return (
    <div className="table-spot relative flex h-full flex-col rounded-3xl border border-white/10 p-3">
      {/* 出牌倒计时：牌桌右上角大号显示（与左栏卡片倒计时并存） */}
      <CenterTurnTimer game={game} />
      <TopBanner game={game} />

      {/* 关键节点大图：翻牌定起揭人 / 亮主 / 揭底定主（中央牌桌停留展示） */}
      <CenterEventOverlay game={game} send={send} />

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_auto_1fr] grid-rows-[auto_1fr_auto] gap-2">
        {/* 上下两行用固定行高（不是 min-h）：出牌区在「只有名字的小药丸」(24px) 与
            「带牌面的大框」(136px，挂了亮主标记时 140px) 之间切换，auto 行会把中间的
            信息区顶得上下抖动。min-h 不够——140px 会顶破它，仍有 4px 抖动，实测过。
            9.5rem = 152px 留足余量；内容再高也只是溢出显示，绝不推动这一行。
            牌面尺寸仍可随屏幕变化 —— 变的是牌，不是这一行占的位置。 */}
        <div className="col-start-2 row-start-1 flex h-[9.5rem] items-center justify-center">
          <PlayZone player={top} game={game} side="top" />
        </div>
        {/* 左右出牌区在各自那一栏里居中：即「中央信息区边缘 → 牌桌外缘」这段空间的正中，
            而不是贴着中央信息区。贴中间会显得挤，四个方位也不对称。 */}
        <div className="col-start-1 row-start-2 flex items-center justify-center">
          <PlayZone player={left} game={game} side="left" />
        </div>
        <div className="col-start-2 row-start-2 flex flex-col items-center justify-center gap-1.5">
          <CenterInfo game={game} />
          {/* 埋好的 8 张底牌：牌背列在牌桌中央，埋入的件（A/K）明牌亮出 */}
          <KittyBacksRow game={game} />
        </div>
        <div className="col-start-3 row-start-2 flex items-center justify-center">
          <PlayZone player={right} game={game} side="right" />
        </div>
        <div className="col-start-2 row-start-3 flex h-[9.5rem] items-center justify-center">
          <PlayZone player={bySeat[you.seat]} game={game} side="self" isYou />
        </div>
      </div>

      <ControlBar
        game={game}
        send={send}
        error={error}
        selected={selected}
        onClear={() => setSelected([])}
        onDeclareOptions={setDeclareOptions}
        onTogglePlayers={onTogglePlayers}
        onToggleChat={onToggleChat}
      />

      <HandArea
        game={game}
        selected={selected}
        onToggle={toggleCard}
        onDragAdd={addDragSelection}
        onToggleGroup={toggleGroupSelection}
        onDeclareRank={cardId => send({ type: 'declareTrump', cardId })}
      />

      {/* 碾压判定面板：摊开四家剩余手牌 + 看结算按钮（不自动跳走） */}
      {game.phase === 'DOMINANCE' && (
        <DominancePanel game={game} onConfirm={() => send({ type: 'confirmDominance' })} />
      )}

      {/* 结算面板：SCORING / ROUND_END / GAME_OVER 覆盖在牌桌上 */}
      {(game.phase === 'SCORING' || game.phase === 'ROUND_END' || game.phase === 'GAME_OVER') && (
        <SettlementPanel game={game} send={send} />
      )}

      {declareOptions && (
        <DeclareModal
          options={declareOptions}
          onPick={cardId => {
            send({ type: 'declareTrump', cardId });
            setDeclareOptions(null);
          }}
          onClose={() => setDeclareOptions(null)}
        />
      )}
    </div>
  );
}

// 牌桌中央右上角的出牌倒计时（大号醒目；最后 10 秒变红，提示音在左栏组件内）
function CenterTurnTimer({ game }) {
  const round = game.round;
  const active =
    game.phase === 'PLAYING' && round && !round.lastTrick && round.turnSeat !== null;
  const now = useNow(active, 300);
  const left = secondsLeft(round?.playDeadline, now);
  if (!active || left === null) return null;
  const player = game.players.find(p => p.seat === round.turnSeat);
  const urgent = left <= 10;
  return (
    // 竖屏窄屏：横排的「⏱时间 + 人名」会横跨到顶部信息条上面，把「庄家：X」压住。
    // 改成上下两行并整体缩小，宽度收到 ~60px，就落在信息条右侧的空白里了。
    <div className="absolute right-3 top-3 z-10 flex items-center gap-2 portrait:max-lg:right-1 portrait:max-lg:top-1 portrait:max-lg:flex-col portrait:max-lg:items-end portrait:max-lg:gap-0.5">
      <span
        className={`rounded-full px-4 py-2 text-lg font-black shadow-lg portrait:max-lg:px-2 portrait:max-lg:py-0.5 portrait:max-lg:text-xs portrait:max-lg:leading-tight ${
          urgent ? 'bg-rose-500 text-white' : 'bg-black/50 text-amber-300'
        }`}
      >
        ⏱ {Math.floor(left / 60)}:{String(Math.ceil(left % 60)).padStart(2, '0')}
      </span>
      {player && (
        <span className="pill bg-black/50 text-white/80 portrait:max-lg:px-1.5 portrait:max-lg:py-0 portrait:max-lg:text-[10px] portrait:max-lg:leading-tight">
          {PLAYER_EMOJI[player.id]} {player.nickname}
        </span>
      )}
    </div>
  );
}

// 关键节点大图：全场只发生一次、决定后续行动顺序的事件，在中央牌桌大图停留展示。
// 消息流是流水账（回溯用）；这里是让四家同步的当下通知（大图 + 换算过程 + 高亮结论）。
// 翻到大小王作废时每一次都展示，绝不静默重翻。
function CenterEventOverlay({ game, send }) {
  const round = game.round;
  if (!round) return null;
  const flip = round.flipEvent;
  const trump = round.trumpEvent;
  const fbCard = round.fallbackTrumpCard;

  const now = useNow(true, 200);
  const showFlipJoker = game.phase === 'REVEAL_FIRST' && flip?.kind === 'JOKER';
  // 起揭人定出后阶段仍停在 REVEAL_FIRST（停留供四家看清），此时展示大图 + 「知道了」
  const showFlipStarter =
    flip?.kind === 'STARTER' &&
    !round.trumpSuit &&
    (game.phase === 'REVEAL_FIRST'
      ? round.flipDone
      : game.phase === 'REVEALING' && round.drawnCount === 0);

  // 亮主 / 揭底定主：DEALING 阶段 + 进入换底后继续停留 ~2.5 秒
  const showTrump =
    !!trump &&
    (game.phase === 'DEALING' || (game.phase === 'KITTY_EXCHANGE' && now - trump.ts < 2500));
  const [fbSeenAt, setFbSeenAt] = useState(null);
  useEffect(() => {
    if (fbCard) setFbSeenAt(Date.now());
  }, [fbCard?.id]);
  const showFallback =
    !!fbCard &&
    !trump &&
    (game.phase === 'DEALING' ||
      (game.phase === 'KITTY_EXCHANGE' && fbSeenAt !== null && now - fbSeenAt < 2500));
  const showFallbackProgress = game.phase === 'FALLBACK_TRUMP';

  if (!showFlipJoker && !showFlipStarter && !showTrump && !showFallback && !showFallbackProgress) {
    return null;
  }

  const playerBySeat = seat => game.players.find(p => p.seat === seat);
  const flipper = playerBySeat(game.flipperSeat);

  let content = null;
  if (showFlipJoker) {
    content = (
      <>
        <PlayingCard suit={flip.card.suit} rank={flip.card.rank} size="xl" className="card-pop" />
        <div className="mt-2 text-xl font-black text-amber-300">{cardLabel(flip.card)} 无点数</div>
        <div className="text-sm font-bold text-white/80">作废重翻：接着翻下一张</div>
      </>
    );
  } else if (showFlipStarter) {
    const n = flip.card.rank === 14 ? 1 : flip.card.rank;
    const r = n % 4;
    const rel = r === 1 ? '翻牌人自己' : r === 2 ? '下家' : r === 3 ? '对家' : '上家';
    const starter = playerBySeat(flip.starterSeat);
    content = (
      <>
        <div className="text-sm font-bold text-white/70">
          {flipper ? `${PLAYER_EMOJI[flipper.id]} ${flipper.nickname}` : '—'} 按下揭牌
        </div>
        <PlayingCard suit={flip.card.suit} rank={flip.card.rank} size="xl" className="card-pop" />
        <div className="mt-1 font-black text-amber-300">
          {cardLabel(flip.card)} = {n} → {n} ÷ 4 余 {r} → {rel}
        </div>
        <div className="mt-1 text-lg font-black text-white">
          起揭人：
          <span className="ml-2 rounded-full bg-amber-400 px-3 py-0.5 text-amber-950">
            {starter ? `${PLAYER_EMOJI[starter.id]} ${starter.nickname}` : '—'}
          </span>
        </div>
        {game.phase === 'REVEAL_FIRST' && <FlipHoldConfirm game={game} send={send} />}
      </>
    );
  } else if (showTrump) {
    const declarer = playerBySeat(trump.declarerSeat);
    content = (
      <>
        <PlayingCard suit={trump.card.suit} rank={trump.card.rank} size="xl" className="card-pop" />
        <div className="mt-2 text-xl font-black text-amber-300">
          {declarer ? `${PLAYER_EMOJI[declarer.id]} ${declarer.nickname}` : ''} 亮 {cardLabel(trump.card)}，
          主牌为 {SUIT_INFO[trump.card.suit].name}
        </div>
        {trump.wasFirstRound && (
          <div className="text-sm font-bold text-white/80">{declarer?.nickname} 成为庄家</div>
        )}
      </>
    );
  } else if (showFallback) {
    content = (
      <>
        <div className="text-sm font-bold text-white/70">无人亮主，揭底定主</div>
        <div className="flex items-center gap-1">
          {(round.fallbackRevealed ?? []).map(c => (
            <div key={c.id} className={c.id === fbCard.id ? 'rounded-lg ring-2 ring-amber-300' : ''}>
              <PlayingCard suit={c.suit} rank={c.rank} size="md" className="card-pop" />
            </div>
          ))}
        </div>
        <div className="mt-1 text-lg font-black text-amber-300">
          主牌为 {SUIT_INFO[fbCard.suit].name}（{cardLabel(fbCard)} 定的主）
        </div>
      </>
    );
  } else if (showFallbackProgress) {
    content = (
      <>
        <div className="text-sm font-bold text-white/70">逐张揭底牌（级牌优先定主，否则首张非王定主）</div>
        <div className="flex items-center gap-1">
          {(round.fallbackRevealed ?? []).map(c => (
            <PlayingCard key={c.id} suit={c.suit} rank={c.rank} size="md" className="card-pop" />
          ))}
          {Array.from({ length: Math.max(0, 8 - (round.fallbackRevealed?.length ?? 0)) }).map((_, i) => (
            <PlayingCard key={`back-${i}`} suit={null} rank={null} faceUp={false} size="md" className="opacity-60" />
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
      <div className="pointer-events-auto flex flex-col items-center rounded-3xl border-2 border-amber-300/60 bg-black/75 px-6 py-4 shadow-2xl">
        {content}
      </div>
    </div>
  );
}

// 起揭人定出后的「知道了」确认条：倒计时 + 已确认人数 + 自己的按钮。
// 服务端持有截止时刻与确认名单，这里只做展示与发送意图。
function FlipHoldConfirm({ game, send }) {
  const round = game.round;
  const confirms = round?.flipConfirms ?? [];
  const now = useNow(true, 500);
  const left = secondsLeft(round?.flipHoldDeadline, now);
  const mine = confirms.includes(game.you.seat);
  return (
    <div className="mt-3 w-full rounded-xl bg-white/10 p-2">
      <div className="flex items-center justify-center gap-2 text-xs font-bold text-white/60">
        <span>已知道 {confirms.length}/4</span>
        <span className="flex gap-1">
          {[...game.players]
            .sort((a, b) => a.seat - b.seat)
            .map(p => (
              <span
                key={p.id}
                title={`${p.nickname}${confirms.includes(p.seat) ? ' 已知道' : ' 还在看'}`}
                className={`pill ${
                  confirms.includes(p.seat)
                    ? 'bg-emerald-400/25 text-emerald-200'
                    : 'bg-white/10 text-white/40'
                }`}
              >
                {PLAYER_EMOJI[p.id]}
              </span>
            ))}
        </span>
        {left !== null && (
          <span className={left <= 3 ? 'text-rose-300' : 'text-white/50'}>
            · {Math.ceil(left)} 秒后自动开揭
          </span>
        )}
      </div>
      <div className="mt-2 flex justify-center">
        <button className="btn-gold" disabled={mine} onClick={() => send({ type: 'confirmFlip' })}>
          {mine ? '已知道，等其他人…' : '知道了'}
        </button>
      </div>
    </div>
  );
}

function TopBanner({ game }) {
  const round = game.round;
  const declarer = game.players.find(p => p.seat === game.declarerSeat);
  return (
    <div className="mb-2 flex flex-wrap items-center justify-center gap-2">
      <span className="pill bg-white/10 text-white/70">第 {round ? round.roundNumber : 1} 局</span>
      <span className="pill bg-white/10 text-white/70">级牌：{round ? rankLabel(round.rankCard) : '2'}</span>
      <span className="pill bg-amber-400/15 text-amber-300">
        庄家：{declarer ? `${PLAYER_EMOJI[declarer.id]} ${declarer.nickname}` : '未定'}
      </span>
      {round && (game.phase === 'REVEALING' || game.phase === 'REVEAL_FIRST') && (
        <span className="pill bg-white/10 text-white/70">底牌 8 张</span>
      )}
    </div>
  );
}

function CenterInfo({ game }) {
  const [showHint, setShowHint] = useState(false);
  const round = game.round;
  const trumpSuit = round?.trumpSuit ?? null;
  const pts = round?.defenderTrickPoints ?? 0;
  const pct = Math.min(100, (pts / 80) * 100);
  const now = useNow(game.phase === 'REVEALING');
  const drawLeft = secondsLeft(round?.drawDeadline, now);
  const graceLeft = secondsLeft(round?.graceDeadline, now);

  return (
    <div className="flex h-44 w-60 flex-col items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-center portrait:max-lg:h-auto portrait:max-lg:w-40 portrait:max-lg:gap-1 portrait:max-lg:px-2 portrait:max-lg:py-1.5">
      <div
        className={`text-4xl font-black ${
          trumpSuit ? (suitRed(trumpSuit) ? 'text-rose-400' : 'text-white/90') : 'text-white/30'
        }`}
      >
        {trumpSuit ? suitSymbol(trumpSuit) : '?'}
      </div>
      <div className="text-xs font-bold text-white/60">
        {round
          ? trumpSuit
            ? `主牌：${suitSymbol(trumpSuit)} · 打 ${rankLabel(round.rankCard)}`
            : `打 ${rankLabel(round.rankCard)} · 主牌未定`
          : '未开局'}
      </div>

      {game.phase === 'REVEAL_FIRST' && round.flipShown.length > 0 && (
        <div className="flex items-center gap-1">
          {round.flipShown.map(c => (
            <PlayingCard key={c.id} suit={c.suit} rank={c.rank} size="sm" className="card-pop" />
          ))}
        </div>
      )}
      {game.phase === 'REVEALING' && (
        <>
          <div className="pill bg-white/10 text-white/80">已揭 {round.drawnCount}/100</div>
          {round.drawnCount < 100 && drawLeft !== null && (
            <div className="pill bg-amber-400/15 text-amber-300">⏱ {drawLeft.toFixed(1)}s</div>
          )}
          {round.drawnCount >= 100 && graceLeft !== null && (
            <div className="pill bg-rose-400/20 text-rose-200">亮主宽限 {graceLeft.toFixed(1)}s</div>
          )}
        </>
      )}
      {game.phase === 'FALLBACK_TRUMP' && (
        <div className="flex items-center gap-1">
          {round.fallbackRevealed.map(c => (
            <PlayingCard key={c.id} suit={c.suit} rank={c.rank} size="sm" className="card-pop" />
          ))}
        </div>
      )}

      <div className="pill bg-amber-400/15 text-amber-300">闲家 {pts} / 80</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-rose-400 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* 阶段说明：竖屏窄屏空间宝贵，整段文字换成一个「说明」小按钮，点开才看 */}
      <div className="text-xs font-bold text-white/70 portrait:max-lg:hidden">
        {PHASE_HINTS[game.phase]}
      </div>
      <button
        type="button"
        className="hidden rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-black text-white/70 portrait:max-lg:block"
        onClick={() => setShowHint(true)}
      >
        说明
      </button>
      {showHint && (
        <Modal title={PHASE_NAMES_CN[game.phase] ?? game.phase} onClose={() => setShowHint(false)}>
          <p className="py-2 text-sm font-bold leading-relaxed text-white/80">
            {PHASE_HINTS[game.phase]}
          </p>
        </Modal>
      )}
    </div>
  );
}

// 碾压判定面板：摊开四家剩余手牌 + 说明 + 看结算按钮（不自动跳走）
function DominancePanel({ game, onConfirm }) {
  const dom = game.round?.dominance;
  const hands = game.round?.allHandsRevealed ?? [];
  if (!dom) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-4">
      <div className="panel max-h-full w-[min(94%,520px)] overflow-y-auto p-5">
        <h2 className="text-center text-xl font-black text-amber-300">碾压收尾</h2>
        <p className="mt-2 text-center text-sm font-bold text-white/80">
          剩余 <span className="text-amber-300">{dom.remainingTricks}</span> 轮全部由{' '}
          <span className="text-amber-300">{dom.winningTeam === 0 ? '金队' : '青队'}</span> 赢下，
          共 <span className="text-amber-300">{dom.remainingPoints}</span> 分
          （{dom.pointsToDefender ? '计入闲家' : '庄家跑掉'}
          {dom.kittyGrab ? '，闲家撬底' : ''}）。
        </p>
        <div className="mt-3 space-y-1.5">
          {hands.map(h => {
            const p = game.players.find(x => x.seat === h.seat);
            return (
              <div key={h.seat} className="flex items-center gap-2 rounded-xl bg-white/5 p-1.5">
                <span className="w-16 shrink-0 text-xs font-black text-white/70">
                  {p?.nickname ?? h.seat}
                </span>
                <div className="flex flex-wrap gap-0.5">
                  {h.cards.map(c => (
                    <PlayingCard key={c.id} suit={c.suit} rank={c.rank} size="sm" />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 text-center">
          <button className="btn-gold" onClick={onConfirm}>
            看结算
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// 结算面板：把本局讲清楚（SCORING / ROUND_END 停留展示，GAME_OVER 常驻 + 再来一局）
function SettlementPanel({ game, send }) {
  const round = game.round;
  const summary = game.rounds?.[game.rounds.length - 1];
  const declarer = game.players.find(p => p.seat === summary?.declarerSeat);
  const next = game.players.find(p => p.seat === summary?.nextDeclarerSeat);
  const kitty = round?.kittyRevealed ?? [];
  const story = useMemo(
    () =>
      roundStory(summary, round?.trickHistory ?? [], seat =>
        game.players.find(p => p.seat === seat)?.nickname
      ),
    [summary, round?.trickHistory, game.players]
  );
  return createPortal(
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-4">
      <div className="panel w-[min(94%,440px)] p-5">
        <h2 className="text-center text-xl font-black text-amber-300">
          {game.phase === 'GAME_OVER'
            ? `🏆 ${game.gameWinnerTeam === 0 ? '金队' : '青队'}获胜！`
            : `第 ${round?.roundNumber} 局结束`}
        </h2>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm font-bold">
          <div className="rounded-xl bg-white/5 p-2">
            <div className="text-white/50">闲家台面</div>
            <div className="text-lg font-black text-amber-300">{round?.defenderTrickPoints ?? 0}</div>
          </div>
          <div className="rounded-xl bg-white/5 p-2">
            <div className="text-white/50">庄家跑掉</div>
            <div className="text-lg font-black text-white/70">{round?.runAwayPoints ?? 0}</div>
          </div>
          <div className="rounded-xl bg-white/5 p-2">
            <div className="text-white/50">底牌</div>
            <div className="text-lg font-black text-sky-300">{round?.kittyPoints ?? 0}</div>
          </div>
        </div>
        <div className="mt-2 text-center text-xs font-bold text-white/60">
          闲家台面 + 跑掉 + 底牌 ={' '}
          {(round?.defenderTrickPoints ?? 0) + (round?.runAwayPoints ?? 0) + (round?.kittyPoints ?? 0)} / 200
          {summary && !summary.conservationOk && <span className="text-rose-300"> ⚠️ 守恒异常</span>}
        </div>

        <div className="mt-3 flex justify-center gap-1">
          {kitty.map(c => (
            <PlayingCard key={c.id} suit={c.suit} rank={c.rank} size="sm" className="card-pop" />
          ))}
        </div>
        <div className="mt-1 text-center text-[11px] font-bold text-white/40">
          底牌揭晓{summary?.kittyGrab ? ' · 闲家撬底' : ''}
        </div>

        <div className="mt-3 rounded-xl bg-amber-400/10 p-3 text-center text-sm font-black text-amber-200">
          最终 P = {round?.defenderPoints ?? 0}
          <span className="ml-2 rounded-full bg-white/10 px-2 py-0.5">
            {summary?.transfer ? '移庄' : '连庄'}
          </span>
          <span className="ml-2">
            {summary && summary.upgradeCount > 0
              ? `${summary.upgradedTeam === 0 ? '金队' : '青队'}升 ${summary.upgradeCount} 级`
              : '双方不升级'}
          </span>
        </div>
        {/* 本局复盘：这局是怎么赢/怎么输的，几句话讲清 */}
        {story.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-xl bg-black/25 p-3 text-left text-xs font-bold leading-relaxed text-white/75">
            {story.map((line, i) => (
              <li key={i}>· {line}</li>
            ))}
          </ul>
        )}

        {game.phase !== 'GAME_OVER' && summary && (
          <p className="mt-2 text-center text-xs font-bold text-white/70">
            下一局：{next?.nickname} 做庄 · 打 {levelLabel(game.teamLevels[summary.nextDeclarerSeat % 2])}
          </p>
        )}

        {/* 小结停留 100 秒供复盘；四人都点「看完了」提前进入下一局 */}
        {game.phase === 'ROUND_END' && (
          <RoundEndConfirm game={game} send={send} />
        )}
        <p className="mt-1 text-center text-[11px] font-bold text-white/40">
          本局：{declarer?.nickname} 做庄 · 主{suitSymbol(round?.trumpSuit)}打 {rankLabel(round?.rankCard)}
        </p>
        {game.phase === 'GAME_OVER' && <RematchPanel game={game} send={send} />}
      </div>
    </div>,
    document.body
  );
}

// 本局小结的「看完了」确认条：倒计时 + 已确认人数 + 自己的按钮。
// 服务端持有截止时刻与确认名单，这里只做展示与发送意图。
function RoundEndConfirm({ game, send }) {
  const round = game.round;
  const confirms = round?.roundEndConfirms ?? [];
  const now = useNow(true, 500);
  const left = secondsLeft(round?.roundEndDeadline, now);
  const mine = confirms.includes(game.you.seat);
  return (
    <div className="mt-3 rounded-xl bg-white/5 p-3">
      <div className="flex items-center justify-center gap-2 text-xs font-bold text-white/60">
        <span>已看完 {confirms.length}/4</span>
        <span className="flex gap-1">
          {[...game.players]
            .sort((a, b) => a.seat - b.seat)
            .map(p => (
              <span
                key={p.id}
                title={`${p.nickname}${confirms.includes(p.seat) ? ' 已看完' : ' 还在看'}`}
                className={`pill ${
                  confirms.includes(p.seat)
                    ? 'bg-emerald-400/25 text-emerald-200'
                    : 'bg-white/10 text-white/40'
                }`}
              >
                {PLAYER_EMOJI[p.id]}
              </span>
            ))}
        </span>
        {left !== null && (
          <span className={left <= 10 ? 'text-rose-300' : 'text-white/50'}>
            · {Math.ceil(left)} 秒后自动继续
          </span>
        )}
      </div>
      <div className="mt-2 flex justify-center">
        <button
          className="btn-gold"
          disabled={mine}
          onClick={() => send({ type: 'confirmRoundEnd' })}
        >
          {mine ? '已确认，等其他人…' : '看完了，下一局'}
        </button>
      </div>
    </div>
  );
}

// 再来一局（提案制）：发起新开一局提案（四人全同意才执行）；管理员可强制重置
function RematchPanel({ game, send }) {
  const [showPropose, setShowPropose] = useState(false);
  const [showForce, setShowForce] = useState(false);
  return (
    <div className="mt-3 rounded-xl bg-white/5 p-3 text-center">
      <div className="flex justify-center gap-2">
        <button className="btn-gold" onClick={() => setShowPropose(true)}>
          🔄 提议新开一局
        </button>
        {game.you.isAdmin && (
          <button
            className="rounded-full bg-rose-500/80 px-5 py-2.5 font-black text-white transition hover:brightness-110"
            onClick={() => setShowForce(true)}
          >
            ⛔ 强制重置
          </button>
        )}
      </div>
      <p className="mt-2 text-xs font-bold text-white/50">
        新开一局需四人全部同意（任一人拒绝即取消，60 秒无响应自动取消）。
      </p>
      {showPropose && !game.resetProposal && (
        <ProposeResetModal game={game} send={send} onClose={() => setShowPropose(false)} />
      )}
      {showForce && <ForceResetModal game={game} send={send} onClose={() => setShowForce(false)} />}
    </div>
  );
}

// 埋好的 8 张底牌：牌背列在牌桌中央；埋入的件（副牌 A/K）按规则明牌亮出
// 底牌行：竖屏窄屏改用更小的牌与更紧的间距 —— 这里真正要看的只有
// 「被系统亮出来的副牌 A/K（件）」，其余牌背只是占位。
function KittyBacksRow({ game }) {
  const round = game.round;
  if (!round || game.phase !== 'PLAYING' && game.phase !== 'DOMINANCE') return null;
  const total = round.kittyCount ?? 0;
  if (total <= 0) return null;
  const revealed = round.kittyRevealedPieces ?? [];
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/25 px-3 py-1.5 portrait:max-lg:gap-1 portrait:max-lg:px-1.5 portrait:max-lg:py-1">
      <span className="text-[10px] font-bold text-white/40 portrait:max-lg:hidden">底牌</span>
      <div className="flex">
        {Array.from({ length: total }, (_, i) => {
          const piece = revealed[i] ?? null; // 明牌亮出的件排在前面
          return piece ? (
            <PlayingCard
              key={`kitty-${i}`}
              suit={piece.suit}
              rank={piece.rank}
              size="sm"
              className="card-pop"
            />
          ) : (
            <PlayingCard
              key={`kitty-${i}`}
              suit={null}
              rank={null}
              faceUp={false}
              size="sm"
              className="-ml-3 first:ml-0 portrait:max-lg:-ml-[1.35rem]"
            />
          );
        })}
      </div>
      {revealed.length > 0 && (
        <span className="text-[10px] font-bold text-amber-300">已亮 {revealed.length} 件</span>
      )}
    </div>
  );
}

// 出牌区：揭牌提示 / 本轮已打出的牌 / 上一轮停留展示 + 赢家高亮；
// 本轮未打完时，浅绿底标记当前牌面最大的人（与最终结算同一套判定）
function PlayZone({ player, game, side = 'top', isYou }) {
  const round = game.round;
  const revealing =
    game.phase === 'REVEALING' && round && round.drawnCount < 100 && !round.trumpSuit;
  const isDrawer = revealing && round.revealTurnSeat === player.seat;
  const play =
    round?.currentTrick?.find(p => p.seat === player.seat) ??
    round?.lastTrick?.plays?.find(p => p.seat === player.seat);
  const isWinner = !!round?.lastTrick && round.lastTrick.winnerSeat === player.seat;

  // 本轮进行中：当前牌面最大者浅绿高亮
  const leading = useMemo(() => {
    if (!round || !round.trumpSuit || !round.currentTrick || round.currentTrick.length === 0) return false;
    if (round.lastTrick) return false; // 停留展示期以赢家高亮为准
    const leader = trickLeader(round.currentTrick, {
      trumpSuit: round.trumpSuit,
      rankCard: round.rankCard,
    });
    return leader?.seat === player.seat;
  }, [round, player.seat]);

  // 聊天气泡：该玩家最近 3 秒内的发言显示在其方位
  const now = useNow(true, 500);
  const latestChat = [...(game.chat ?? [])]
    .reverse()
    .find(m => m.from === player.id);
  const showBubble = latestChat && now - latestChat.ts < 3000;

  // 「吊主」气泡：首家出主牌且上一轮非主牌（连续主牌只弹一次）
  const tiaoZhu = tiaoZhuActive(round?.currentTrick ?? [], round?.trickHistory ?? []);
  const showTiaoZhu = tiaoZhu && round?.currentTrick?.[0]?.seat === player.seat;
  const hasPlay = !!play && play.cards.length > 0;
  const sideways = side === 'left' || side === 'right';

  // 亮主标记：谁把主牌亮出来的。
  // trumpEvent 是有人手持级牌亮主（第二局起亮主者可以是闲家，与庄家无关）；
  // 揭底定主（fallbackTrumpCard）没有"亮主人"，此时四家都不挂这个标记。
  const isDeclarer =
    !!round?.trumpEvent && round.trumpEvent.declarerSeat === player.seat;
  const trumpDeclaredLabel = isDeclarer ? suitSymbol(round.trumpEvent.card.suit) : '';

  return (
    <div
      data-playzone={player.seat}
      className={`relative flex flex-col items-center ${
        hasPlay
          ? `gap-1 rounded-2xl border-2 p-2 ${
              isWinner
                ? 'winner-glow border-amber-300/80 border-solid'
                : leading
                  ? 'border-solid border-emerald-300/70 bg-emerald-400/15'
                  : 'border-dashed border-white/15 bg-black/10'
            }`
          : 'rounded-full bg-black/25 px-3 py-1'
      }`}
    >
      {showBubble && (
        <div className="chat-bubble absolute -top-5 left-1/2 z-30 max-w-48 -translate-x-1/2">
          {latestChat.text}
        </div>
      )}
      {showTiaoZhu && (
        <div className="tiaozhu-bubble absolute -top-9 left-1/2 z-30 -translate-x-1/2">
          吊主
        </div>
      )}
      {play?.nii && (
        <div className="nii-bubble absolute -top-14 left-1/2 z-30 -translate-x-1/2">
          妮！
        </div>
      )}
      {/* 大鬼彩蛋：比「妮！」再高一档，两个同时出现时不叠在一起 */}
      {play?.pudiao && (
        <div className="pudiao-bubble absolute -top-[4.75rem] left-1/2 z-30 -translate-x-1/2">
          谱掉你
        </div>
      )}
      <div className="flex items-center gap-1 text-xs font-black text-white/80">
        {PLAYER_EMOJI[player.id]} {player.nickname}
        {isYou ? '(我)' : ''}
        {isDeclarer && (
          // 谁亮的主：第二局起亮主者不一定是庄家，所以这是独立于「庄」的标记
          <span
            className="pill bg-amber-400/25 text-amber-200"
            title={`${player.nickname} 亮的主：${trumpDeclaredLabel}`}
          >
            亮{trumpDeclaredLabel}
          </span>
        )}
        {isWinner ? ' 🏆' : leading ? ' 👑' : ''}
      </div>
      {/* 出牌区自适应：没牌时只剩方位名一条细线；有牌按张数展开（容量 10 张，超出再压缩） */}
      {hasPlay && (
        <div className="flex items-center justify-center">
          {/* 左右两侧在竖屏手机上改为竖向叠放：竖屏横向空间本来就窄，
              甩牌多张时横排会把中间牌桌挤没。单张时横竖一样，无影响。
              仅限竖屏 + 窄屏，横屏和桌面保持原来的横排。 */}
          <div className={`flex ${sideways ? 'portrait:max-lg:flex-col' : ''}`}>
            {play.cards.map((c, i) => (
              <PlayingCard
                key={c.id}
                suit={c.suit}
                rank={c.rank}
                size="xl"
                className={`card-pop ${
                  i === 0
                    ? ''
                    : sideways
                      ? `${play.cards.length > 10 ? '-ml-[54px]' : '-ml-12'} portrait:max-lg:ml-0 portrait:max-lg:-mt-[4.5rem]`
                      : play.cards.length > 10
                        ? '-ml-[54px]'
                        : '-ml-12'
                }`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ControlBar({ game, send, error, selected, onClear, onDeclareOptions, onTogglePlayers, onToggleChat }) {
  const you = game.you;
  const round = game.round;
  const now = useNow(game.phase === 'REVEALING');
  const buttons = [];
  const hints = []; // 提示与辅助按钮：单独一行放在主按钮下方，不跟主按钮抢横向空间

  // 出牌阶段的本地校验（与服务端同一份纯函数），用于禁用与提示
  const verdict = useMemo(
    () => (game.phase === 'PLAYING' ? checkSelection(game, selected) : null),
    [game, selected]
  );
  const myPlayTurn =
    game.phase === 'PLAYING' && round && !round.lastTrick && round.turnSeat === you.seat;

  if (game.phase === 'SEATING') {
    buttons.push(
      <button
        key="seat"
        className="btn-gold"
        disabled={you.seatLocked}
        onClick={() => send({ type: 'confirmSeat' })}
      >
        {you.seatLocked ? '已确认座位 ✓' : '确认座位'}
      </button>
    );
  } else if (game.phase === 'READY_CHECK') {
    buttons.push(
      <button key="ready" className="btn-gold" onClick={() => send({ type: 'ready' })}>
        {you.ready ? '取消准备' : '准备'}
      </button>
    );
  } else if (game.phase === 'REVEAL_FIRST') {
    buttons.push(
      <button
        key="flipper"
        className="btn-gold"
        disabled={game.flipperSeat !== null}
        onClick={() => send({ type: 'claimFlipper' })}
      >
        {game.flipperSeat === you.seat
          ? '你已揭牌 ✓'
          : game.flipperSeat !== null
            ? '已有人揭牌'
            : '揭牌'}
      </button>
    );
  } else if (game.phase === 'REVEALING') {
    const myTurn =
      round && round.drawnCount < 100 && !round.trumpSuit && round.revealTurnSeat === you.seat;
    const drawer = game.players.find(p => p.seat === round.revealTurnSeat);
    buttons.push(
      <button
        key="draw"
        className="btn-gold"
        disabled={!myTurn}
        onClick={() => send({ type: 'drawCard' })}
      >
        {myTurn ? '揭牌（空格）' : `等待 ${drawer?.nickname ?? '—'} 揭牌`}
      </button>
    );
    if (round.drawnCount < 100) {
      const left = secondsLeft(round.drawDeadline, now);
      if (left !== null) {
        buttons.push(
          <span key="t" className="pill bg-amber-400/15 text-amber-300">
            ⏱ {left.toFixed(1)}s
          </span>
        );
      }
    }
    // 亮主：手里有未亮出的级牌即可按（与揭牌回合无关，宽限窗口内同样可用）
    const rankCards = (you.hand ?? []).filter(c => c.rank === round.rankCard);
    if (rankCards.length > 0) {
      buttons.push(
        <button
          key="declare"
          className="btn-gold"
          onClick={() => {
            const suits = [...new Set(rankCards.map(c => c.suit))];
            if (suits.length === 1) send({ type: 'declareTrump', cardId: rankCards[0].id });
            else onDeclareOptions(rankCards);
          }}
        >
          亮主{rankCards.length > 1 ? `（按 1~${rankCards.length} 直接亮）` : '（按 1 直接亮）'}
        </button>
      );
    }
  } else if (game.phase === 'KITTY_EXCHANGE') {
    if (game.declarerSeat === you.seat) {
      buttons.push(
        <button
          key="bury"
          className="btn-gold"
          disabled={selected.length !== 8}
          onClick={() => send({ type: 'buryKitty', cardIds: selected })}
        >
          埋底 {selected.length}/8
        </button>
      );
    } else {
      buttons.push(
        <span key="wait" className="text-sm font-bold text-white/60">
          等待庄家换底…
        </span>
      );
    }
  } else if (game.phase === 'CROSS_RIVER') {
    // 三主过河：候选人点选「全部主牌 + 副牌补足 3 张」送对家；对家点选 3 张副牌回。
    // 按钮禁用只做基础提示，服务端是唯一权威（对家副牌不足 3 张时服务端拒绝并说明）。
    const cr = you.crossRiver ?? {};
    const isTrumpId = id => {
      const card = (you.hand ?? []).find(c => c.id === id);
      return card ? playSuitOf(card, round.trumpSuit, round.rankCard) === 'TRUMP' : false;
    };
    if (cr.mustRespond) {
      const valid = selected.length === 3 && selected.every(id => !isTrumpId(id));
      buttons.push(
        <button
          key="cr-back"
          className="btn-gold"
          disabled={!valid}
          onClick={() => send({ type: 'respondCrossRiver', cardIds: selected })}
        >
          回 3 张副牌（{selected.length}/3）
        </button>
      );
    } else if (cr.eligible) {
      const selTrumpCount = selected.filter(id => isTrumpId(id)).length;
      const valid = selected.length === 3 && selTrumpCount === you.trumpCount;
      buttons.push(
        <button
          key="cr-go"
          className="btn-gold"
          disabled={!valid}
          onClick={() => send({ type: 'initiateCrossRiver', cardIds: selected })}
        >
          过河送出 3 张（{selected.length}/3）
        </button>
      );
      buttons.push(
        <button key="cr-skip" className="btn-gold-sm" onClick={() => send({ type: 'skipCrossRiver' })}>
          跳过过河
        </button>
      );
    } else if (cr.waiting) {
      buttons.push(
        <span key="cr-wait" className="pill bg-amber-400/15 text-amber-300">
          已发起，等待对家回 3 张副牌…
        </span>
      );
    } else {
      const done = game.round?.crossRiver?.doneTeams ?? [];
      buttons.push(
        <span key="cr-idle" className="pill bg-white/10 text-white/70">
          过河阶段{done.length > 0 ? `（已过河 ${done.length} 队）` : ''}，等待符合条件的人决定…
        </span>
      );
    }
  } else if (game.phase === 'PLAYING') {
    const showVerdict = myPlayTurn && selected.length > 0 && verdict && !verdict.ok;
    buttons.push(
      <button
        key="play"
        className="btn-gold"
        disabled={!myPlayTurn || selected.length === 0 || (verdict ? !verdict.ok : true)}
        onClick={() => send({ type: 'play', cardIds: selected })}
      >
        {myPlayTurn
          ? `出牌（空格）${selected.length > 0 ? ` · ${selected.length} 张` : ''}`
          : round.lastTrick
            ? '上一轮结算中…'
            : `等待 ${game.players.find(p => p.seat === round.turnSeat)?.nickname ?? '—'} 出牌`}
      </button>
    );
    if (showVerdict) {
      hints.push(
        <span key="reason" className="max-w-[18rem] rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-200">
          {verdict.reason}
        </span>
      );
    }
  }

  // 清空选择：有选中时随时可一键取消（拖动只加选不清除，取消交给这里和单击）
  if (
    selected.length > 0 &&
    (game.phase === 'PLAYING' || game.phase === 'KITTY_EXCHANGE' || game.phase === 'CROSS_RIVER')
  ) {
    hints.push(
      <button key="clear" className="btn-gold-sm" onClick={onClear}>
        清空选择 ({selected.length})
      </button>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1.5 py-2">
      {/* 窄屏的左右栏开关跟在主按钮两侧：原来钉在屏幕两个下角，正好压着手牌。
          平时 70% 不透明不抢戏，碰到/按下才实心。
          显示条件沿用原来的断点：玩家列表 <768px 才需要，聊天 <1024px 才需要。 */}
      <div className="relative flex w-full items-center justify-center gap-3">
        {onTogglePlayers && (
          <button
            type="button"
            className="btn-float-sm absolute left-0 md:hidden"
            title="玩家列表"
            onClick={onTogglePlayers}
          >
            👥
          </button>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3">{buttons}</div>
        {onToggleChat && (
          <button
            type="button"
            className="btn-float-sm absolute right-0 lg:hidden"
            title="消息与聊天"
            onClick={onToggleChat}
          >
            💬
          </button>
        )}
      </div>
      {hints.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">{hints}</div>
      )}
      <ErrorToast error={error} />
    </div>
  );
}

// 服务端错误必须明显显示（绝不静默吞掉）：大号红字 + 摇动动画，5 秒后消失
function ErrorToast({ error }) {
  const [shown, setShown] = useState(null);
  useEffect(() => {
    if (!error) return;
    setShown(error);
    const t = setTimeout(() => setShown(null), 5000);
    return () => clearTimeout(t);
  }, [error]);
  if (!shown) return null;
  return (
    <div className="error-toast rounded-full bg-rose-600/90 px-4 py-1.5 text-sm font-black text-white shadow-lg ring-2 ring-rose-300/60">
      ⚠ {shown.reason}
    </div>
  );
}

// 我的手牌：加大号牌面（lg），固定重叠左对齐（每张露 EXPOSE_W 左缘，每组末张露全宽）；
// 按组排列：主牌组在前，副牌组按红黑交替排序；组间间隔规则：
//   · 主牌组 → 第一副牌组：大间隔（明显大于副牌组之间的间隔）
//   · 同色相邻副牌组（无法交替时）：明显间隔
//   · 其余副牌组之间：小间隔
// 每组最后一张牌上方显示张数角标（>5 张才显示）。
// 揭牌阶段可亮级牌自动抬起 + 数字角标（对应快捷键）。
// 出牌/换底/过河阶段：单击 = 切换选中（已选则取消）；按住并拖动 = 只加选（add-only，
// 拖回已选牌不会取消），位移超过 5px 进入拖动模式；触摸同样支持滑动多选。
// 换底时庄家 33 张（底牌已并入，统一排序），从中点选 8 张埋回；
// 过河时点选 3 张（发起者：全部主牌 + 副牌补足；对家：3 张副牌）。
function HandArea({ game, selected, onToggle, onDragAdd, onToggleGroup, onDeclareRank }) {
  const you = game.you;
  const hand = you.hand ?? [];
  const revealing = game.phase === 'REVEALING';
  // 出牌阶段全程可选牌 —— 不必等轮到自己。
  // 没轮到时先把要打的牌挑好，轮到自己直接按「出牌」/空格打出，不用手忙脚乱。
  // 真正的出牌动作仍然只在自己回合可用（服务端另有 NOT_YOUR_TURN 兜底），
  // 而且首家出牌后领出花色才确定，预选可能变成不合法 —— 由 checkSelection 照常提示。
  const selectable = game.phase === 'PLAYING' && !!game.round;
  const exchangeSelectable =
    game.phase === 'KITTY_EXCHANGE' && game.declarerSeat === you.seat;
  const cross = you.crossRiver ?? {};
  const crossSelectable =
    game.phase === 'CROSS_RIVER' && (cross.eligible || cross.mustRespond);
  const interactive = selectable || exchangeSelectable || crossSelectable;

  // 分组（输入已排序手牌；主牌组在最前）
  const groups = useMemo(
    () => handGroups(hand, game.round?.trumpSuit ?? null, game.round?.rankCard),
    [hand, game.round?.trumpSuit, game.round?.rankCard]
  );

  // 固定重叠布局：每张只露出固定宽度（够看清点数 + 花色），整行左对齐。
  // ⚠️ 露出宽度与视口宽度无关 —— 视口再宽也不摊开，牌始终叠在一起。
  //   （旧实现按可用宽度反解间距，视口越宽牌摊得越开，右对齐；已废弃。）
  // 组间隔 = 露出宽度 + 小增量（普通 +8 上限 20；主副分界 +16 上限 32）——
  //   分组主要靠颜色交替与张数角标，间隔只给“比组内略大”的提示。
  // 只有窄到放不下峰值张数时才逐级降低牌面档位，仍不够才压缩露出宽度：
  //   不溢出/不横向滚动这条底线优先于“固定露出”。
  const rowRef = useRef(null);
  const [avail, setAvail] = useState(0);
  // 与 CSS 的 portrait:max-lg: 断点保持一致（手机竖屏 + iPad 竖屏）。
  // 布局算法要按屏幕形态换参数，纯 CSS 做不到，这里用 matchMedia 拿到同一个判断。
  const [compactPortrait, setCompactPortrait] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait) and (max-width: 1023px)');
    const sync = () => setCompactPortrait(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  // hasRow 依赖：手牌行是在揭牌后才挂载的，挂载时立即测量并开始观察（窗口变化实时重算）
  const hasRow = hand.length > 0;
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const update = () => setAvail(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [hasRow]);

  // 牌面档位按阶段峰值锁定（换底 33、其余 25）：按“最多会有多少张”选档，
  // 阶段内固定不变，手牌越打越少也不会突然换档、跳一次位置。
  // 露出宽度本身是定值，只有窄到放不下峰值时才降档/压缩。
  // 左对齐锚定：打掉牌只是行尾变短，已出的牌左侧位置纹丝不动。
  const peak = game.phase === 'KITTY_EXCHANGE' ? 33 : 25;
  const layout = useMemo(() => {
    if (hand.length === 0) return null;
    // 组数按峰值 4 组估算（主牌组 + 3 门副牌组；主副分界 1 条、其余组间 2 条），
    // 与当前实际组数无关 —— 保证某个花色打完后布局仍不变。
    const G = 4;
    const g3 = 1; // 主副分界
    const g2 = 2; // 其余组间
    const denom = Math.max(1, peak - G); // 只露出左缘的张数（每组末张露全宽）
    const gapsFor = s => ({ gap2: Math.min(s + 8, 20), gap3: Math.min(s + 16, 32) });
    const FIXED_GAPS = 20 * g2 + 32 * g3; // 露出宽度够大时组间隔已封顶，按上限估算

    const target = compactPortrait ? PORTRAIT_EXPOSE_W : EXPOSE_W;
    const maxRows = compactPortrait ? MAX_ROWS_PORTRAIT : MAX_ROWS_WIDE;

    if (avail === 0) {
      // 首帧未测量：先按最大档给出目标露出，ResizeObserver 测到后再重算
      const t0 = HAND_TIERS[0];
      return { size: t0.name, w: t0.w, s: target, rows: 1, ...gapsFor(target) };
    }

    // 反解：给定（行数, 牌面档位），这一行最多能给多大的露出宽度？
    // 单行：G 张全宽 + denom 张只露 s + 组间隔 ≤ avail
    // 多行：总宽均摊到每行，再留一张全宽的余量（每行末张要露全）
    const maxExposeFor = (tier, rows) => {
      const budget = rows <= 1 ? avail : (avail - tier.w) * rows;
      return (budget - G * tier.w - FIXED_GAPS) / denom;
    };

    // 择优：行数越少越好；同行数下优先大牌面，只要它的露出宽度还够读
    // （COMFORT 以下就宁可换小一档换取更宽的间隔）。
    const COMFORT = 16;
    let best = null;
    for (let rows = 1; rows <= maxRows; rows++) {
      for (const tier of HAND_TIERS) {
        const s = Math.min(target, maxExposeFor(tier, rows));
        if (s < MIN_EXPOSE_W) continue;
        const cand = { size: tier.name, w: tier.w, s, rows };
        if (s >= COMFORT) return { ...cand, ...gapsFor(s) }; // 够读就收，不再往小降
        // 还不够读：记下目前最宽的一个，等所有组合都试完再用
        if (!best || s > best.s) best = cand;
      }
    }
    if (best) return { ...best, ...gapsFor(best.s) };

    // 所有组合都低于下限：最小档 + 最多行数 + 压到下限（绝不横向溢出）
    const tier = HAND_TIERS[HAND_TIERS.length - 1];
    const s = Math.max(MIN_EXPOSE_W, Math.min(target, maxExposeFor(tier, maxRows)));
    return { size: tier.name, w: tier.w, s, rows: maxRows, ...gapsFor(s) };
  }, [peak, avail, hand.length, compactPortrait]);

  // 拖动多选（add-only）：按下记录起点，位移超过阈值进入拖动模式（起点牌也加选），
  // 滑过的牌全部加选；未超过阈值松手 = 单击切换。状态全走 ref，窗口监听器不闭包过期。
  const dragRef = useRef(null); // { pointerId, x0, y0, moved, originId }
  const liveRef = useRef({ interactive, onToggle, onDragAdd });
  liveRef.current = { interactive, onToggle, onDragAdd };

  useEffect(() => {
    const DRAG_THRESHOLD = 5;
    const move = e => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        if (liveRef.current.interactive) liveRef.current.onDragAdd?.(d.originId);
      }
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-card-id]');
      if (el && liveRef.current.interactive) liveRef.current.onDragAdd?.(el.dataset.cardId);
    };
    const up = e => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      dragRef.current = null;
      if (!d.moved && liveRef.current.interactive) liveRef.current.onToggle?.(d.originId);
    };
    // 手势被系统取消（如手掌误触）：不算单击，也不做任何选中
    const cancel = e => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, []);

  const startDrag = (e, id) => {
    if (!interactive) return;
    if (dragRef.current) return; // 已有拖动进行中（多指触控只认第一根）
    e.preventDefault();
    dragRef.current = {
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
      originId: id,
    };
  };

  // 揭牌阶段：可亮级牌角标（1..N，与数字快捷键对应）
  let rankIndex = 0;
  const rankBadges = new Map();
  if (revealing && game.round) {
    for (const c of hand) {
      if (c.rank === game.round.rankCard) {
        rankIndex += 1;
        rankBadges.set(c.id, rankIndex);
      }
    }
  }

  // groupIndex 为组内序号（组间间隔不参与重叠），组首张不向左重叠。
  //
  // ⚠️ 抬起的牌（可亮级牌 / 已选中）绝不能加 z-10。
  // 手牌是「右压左」的叠放，每张只露出左缘一条；一旦某张被提到上层，
  // 它就会盖住右邻牌的左上角点数 —— 那正是叠放时唯一能读到的位置。
  // 只做垂直位移足够表达抬起：露出的左缘本来就带点数，
  // 再加上抬高的 12px 横条，一眼可见，且不遮任何人。
  const renderCard = (c, groupIndex, group, isLastInGroup, groupIds) => {
    const badge = rankBadges.get(c.id);
    const isSelected = selected.includes(c.id);
    const lifted = badge !== undefined || isSelected;
    const countBadge = isLastInGroup ? groupBadgeCount(group) : null;
    // 重叠量 = 牌宽 − 露出间距（动态计算，不写死）
    const overlap = layout ? layout.w - layout.s : 34;
    return (
      <div
        key={c.id}
        data-card-id={c.id}
        data-suit={c.suit}
        data-rank={c.rank}
        className={`relative shrink-0 transition-transform duration-150 ${
          lifted ? '-translate-y-3' : ''
        } ${interactive ? 'touch-none' : ''}`}
        style={groupIndex > 0 ? { marginLeft: -overlap } : undefined}
      >
        {badge !== undefined && (
          // 角标可直接点按亮主（手机上无键盘，对应数字快捷键）
          <button
            // 角标必须落在本张牌露出的那条左缘上（约 18px 宽）：
            // 原来水平居中在 56px 牌面上，视觉上飘在右邻牌头顶，看不出属于哪张。
            // 纵向压到底部：左上角是本张牌的点数，右下角是旋转点数，中间空白最安全。
            className="absolute bottom-1 left-0 z-20 grid h-6 w-6 place-items-center rounded-full bg-amber-400 text-sm font-black text-amber-950 shadow-md ring-2 ring-amber-200/60 transition hover:scale-110"
            title={`亮主（快捷键 ${badge}）`}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              onDeclareRank?.(c.id);
            }}
          >
            {badge}
          </button>
        )}
        {countBadge !== null && (
          // 组张数角标兼「整组全选」按钮：不可选的阶段退化为纯展示
          <button
            type="button"
            disabled={!interactive}
            title={interactive ? `点击选中这一组全部 ${countBadge} 张（再点取消）` : `本组 ${countBadge} 张`}
            className={`absolute -top-2 right-0 z-20 rounded-full bg-black/70 px-1.5 py-0.5 text-[11px] font-black leading-none text-white/85 ring-1 ring-white/25 ${
              interactive ? 'cursor-pointer hover:scale-110 hover:bg-amber-400 hover:text-amber-950' : ''
            }`}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              onToggleGroup?.(groupIds);
            }}
          >
            {countBadge}
          </button>
        )}
        <PlayingCard
          suit={c.suit}
          rank={c.rank}
          selected={isSelected}
          size={layout?.size ?? 'lg'}
          onPointerDown={e => startDrag(e, c.id)}
          className={`${interactive ? 'cursor-pointer hover:-translate-y-1' : ''}`}
        />
      </div>
    );
  };

  // 按组切片渲染 + 组间间隔（宽度 = 间距倍数：主副分界 3 倍、其余组间 2 倍）。
  // 每组连同它前面的间隔打包成一个 segment，并算出该组占宽 ——
  // 分行时以 segment 为最小单位，绝不把同一花色组拦腰截断。
  const segS = layout?.s ?? EXPOSE_W;
  const segW = layout?.w ?? HAND_TIERS[0].w;
  const segments = [];
  let pos = 0;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const cards = hand.slice(pos, pos + group.count);
    const els = [];
    let gapWidth = 0;
    if (g > 0) {
      const isTrumpGap = groups[g - 1].suit === 'TRUMP' && group.suit !== 'TRUMP';
      gapWidth = layout ? (isTrumpGap ? layout.gap3 : layout.gap2) : 24;
      els.push(
        <div
          key={`gap-${g}`}
          className="h-12 shrink-0"
          style={{ width: gapWidth }}
          title={isTrumpGap ? '主牌组与副牌组分界' : '花色组间隔'}
        />
      );
    }
    const groupIds = cards.map(c => c.id);
    for (let i = 0; i < cards.length; i++) {
      els.push(renderCard(cards[i], i, group, i === cards.length - 1, groupIds));
    }
    // 组宽 = 前置间隔 + (张数-1) 张只露左缘 + 末张露全宽
    segments.push({ els, width: gapWidth + Math.max(0, cards.length - 1) * segS + segW });
    pos += group.count;
  }

  // 分行：把 segment 划到 layout.rows 行，目标是「最宽的一行尽可能窄」。
  // 以花色组为最小单位，绝不拦腰截断（曾经按元素个数平均切，把黑桃切成两半）。
  const rowChunks = (() => {
    if (segments.length === 0) return [[]];
    const ranges = partitionByWidth(segments.map(seg => seg.width), layout?.rows ?? 1);
    return ranges.map(([a, b]) => segments.slice(a, b).flatMap(seg => seg.els));
  })();

  return (
    <div className="rounded-2xl border border-white/10 bg-black/15 p-2">
      <div className="mb-1 flex items-center justify-between text-xs font-bold text-white/50">
        <span>
          {exchangeSelectable
            ? `我的手牌 + 底牌（点选 8 张埋回，已选 ${selected.length}/8）`
            : crossSelectable
              ? cross.mustRespond
                ? `回给对家：点选 3 张副牌（已选 ${selected.length}/3）`
                : `过河送出：全部主牌 + 副牌补足 3 张（已选 ${selected.length}/3）`
              : '我的手牌'}
        </span>
        <span>{hand.length} 张</span>
      </div>
      {hand.length === 0 ? (
        <div className="flex min-h-24 items-center justify-center gap-2">
          <PlayingCard suit={null} rank={null} faceUp={false} className="opacity-40" />
          <span className="text-xs font-bold text-white/40">揭牌后手牌显示在这里</span>
        </div>
      ) : (
        /* 固定重叠 + 左对齐：牌始终叠在一起靠左排，视口再宽也不摊开、不右移。
           顶部预留抬起 + 角标空间（pt-5），不设 overflow hidden，避免抬起的牌被裁掉 */
        <div ref={rowRef} className="flex flex-col gap-1 pb-2 pt-5">
          {rowChunks.map((chunk, i) => (
            <div
              key={i}
              className={`flex items-end ${compactPortrait ? 'justify-center' : 'justify-start'}`}
            >
              {chunk}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 多花色级牌时选择亮哪一张
function DeclareModal({ options, onPick, onClose }) {
  const bySuit = {};
  for (const c of options) {
    (bySuit[c.suit] ??= []).push(c);
  }
  return (
    <Modal title="选择亮主花色" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(bySuit).map(([suit, cards]) => (
          <button
            key={suit}
            className="rounded-xl border border-white/15 bg-white/5 p-3 font-black transition hover:bg-white/15"
            onClick={() => onPick(cards[0].id)}
          >
            <span className={suitRed(suit) ? 'text-rose-400' : 'text-white/90'}>
              {suitSymbol(suit)}
            </span>
            <span className="ml-1 text-white/80">{SUIT_INFO[suit].name}</span>
            <span className="ml-1 text-xs text-white/50">{cards.length} 张</span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs font-bold text-white/50">
        亮主一次性，先按先得；选择后立即定主并停止揭牌。也可直接按数字键 1~N。
      </p>
    </Modal>
  );
}
