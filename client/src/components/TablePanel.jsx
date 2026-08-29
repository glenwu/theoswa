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
import { useNow, secondsLeft, displayNow } from '../useNow.js';
import { useMediaQuery, COMPACT_PORTRAIT, PHONE_LANDSCAPE, COMPACT } from '../useMedia.js';
import { MyDetails } from './PlayerPanel.jsx';
import { shortcutAction } from '../shortcut.js';
import { checkSelection } from '../playCheck.js';
import { seatPendingText } from '../seatStatus.js';
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

// 电脑托管开关。托管期间 AI 用【你自己的手牌】替你打，人还在线、身份不变，
// 随时可以点「取消托管」自己接着打 —— 和「让电脑接管掉线座位」是两回事。
function AutoPlayToggle({ game, send, className = '' }) {
  const on = game.you.autoPlay === true;
  return (
    <button
      type="button"
      className={`rounded-full px-2.5 py-0.5 text-[11px] font-black transition ${
        on
          ? 'bg-cyan-400/85 text-cyan-950 shadow shadow-cyan-400/40 hover:brightness-110'
          : 'bg-white/10 text-white/70 hover:bg-white/20'
      } ${className}`}
      title={on ? '取消托管，自己接着打' : '让电脑用你的手牌替你打，随时可以取消'}
      onClick={() => send({ type: 'setAutoPlay', on: !on })}
    >
      {on ? '🤖 取消托管' : '🤖 托管'}
    </button>
  );
}

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

  // 手机横屏：高度不够，上下堆「牌桌 / 控制栏 / 手牌」会糊成一团（Glen 说没法玩）。
  // 改成左右分栏 —— 牌桌占左边 40%，右边 60% 上面放信息和功能键、下面放手牌。
  const phoneLandscape = useMediaQuery(PHONE_LANDSCAPE);

  const table = (
    // 窄屏去掉牌桌那圈边框（Glen：「把桌面区的边框去掉吧」）——
    // 宽屏上它是用来和左右两栏分界的，窄屏左右两栏本来就收起来了，
    // 那圈线只是白占一圈内边距。
    <div className={`table-spot relative flex min-h-0 flex-col rounded-3xl border border-white/10 compact:border-0 ${
      phoneLandscape ? 'w-2/5 shrink-0 p-1.5' : 'h-full p-3'
    }`}>
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
        <div className={`col-start-2 row-start-1 flex items-center justify-center ${
          phoneLandscape ? 'h-24' : 'h-[9.5rem]'
        }`}>
          <PlayZone player={top} game={game} side="top" />
        </div>
        {/* 左右出牌区在各自那一栏里居中：即「中央信息区边缘 → 牌桌外缘」这段空间的正中，
            而不是贴着中央信息区。贴中间会显得挤，四个方位也不对称。 */}
        <div className="col-start-1 row-start-2 flex items-center justify-center">
          <PlayZone player={left} game={game} side="left" />
        </div>
        <div className="col-start-2 row-start-2 flex flex-col items-center justify-center gap-1.5">
          <CenterInfo game={game} send={send} />
          {/* 埋好的 8 张底牌：牌背列在牌桌中央，埋入的件（A/K）明牌亮出 */}
          <KittyBacksRow game={game} />
        </div>
        <div className="col-start-3 row-start-2 flex items-center justify-center">
          <PlayZone player={right} game={game} side="right" />
        </div>
        <div className={`col-start-2 row-start-3 flex items-center justify-center ${
          phoneLandscape ? 'h-24' : 'h-[9.5rem]'
        }`}>
          <PlayZone player={bySeat[you.seat]} game={game} side="self" isYou />
        </div>
      </div>
    </div>
  );

  const controls = (
    <ControlBar
      game={game}
      send={send}
      error={error}
      selected={selected}
      onClear={() => setSelected([])}
      onDeclareOptions={setDeclareOptions}
      onTogglePlayers={onTogglePlayers}
      onToggleChat={onToggleChat}
      compact={phoneLandscape}
    />
  );

  const hand = (
    <HandArea
      game={game}
      send={send}
      selected={selected}
      onToggle={toggleCard}
      onDragAdd={addDragSelection}
      onToggleGroup={toggleGroupSelection}
      onDeclareRank={cardId => send({ type: 'declareTrump', cardId })}
      className={phoneLandscape ? 'flex h-full flex-col' : ''}
    />
  );

  const overlays = (
    <>
      {/* 碾压判定面板：摊开四家剩余手牌 + 看结算 / 看多一会 */}
      {game.phase === 'DOMINANCE' && <DominancePanel game={game} send={send} />}

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
    </>
  );

  // ---- 手机横屏：左 40% 牌桌 / 右 60% 上信息下手牌（Glen 指定的版式）----
  //
  // 「现在如果手机横屏的话，整个显示会因为高度不够，糊在一起，没法玩，
  //   能否做到只要检测到手机横屏模式，左边 40 左右的宽度显示整个牌桌，
  //   右下 60% 加 50% 的高度显示手牌，还有左右信息框功能框按键，
  //   手牌区上边则显示已打出还有求件的信息加五个功能按钮。」
  //
  // 横屏时左右两个 aside（玩家列表 / 聊天）本来就被 md:/lg: 断点藏起来了，
  // 所以「已打出 + 件」这块打牌时一直要看的信息、以及那五个功能按钮，
  // 必须在这里补回来 —— 否则横屏等于把它们整个弄丢。
  if (phoneLandscape) {
    return (
      <div className="relative flex h-full gap-2">
        {table}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* 上半：「场上已打出 + 件」+ 五个功能按钮横排在它下面。
              ⚠️ 按钮【不能】竖排在右侧：这一栏只有 ~127px 高，五个 36px 的按钮
              竖着要 212px，放不下就得滚，最后两个等于藏起来了。横排一行
              5×36 + 间距 ≈ 200px，在 ~490px 宽里绰绰有余。
              ⚠️ 这一块【按内容撑开】(shrink-0)，弹性留给手牌 —— 反过来写成
              「手牌固定一半、上面 flex-1」实测把件追踪那三行裁掉了
              （容器 87px、内容 121px），而那正是 Glen 点名要看的信息。
              它是固定的一小块，手牌才是会长会短的那个。 */}
          {/* ⚠️ 这里【不再】放那五个功能按钮。一开始按 Glen 的原话补了一份，
              他看到实机之后改口：「5 个在出牌按钮上方的功能键也取消吧，重复了，
              还占地」—— 👥 抽屉里的玩家面板底部本来就有同一组按钮，
              横屏那 390px 高度里，40px 花在重复的东西上太贵。 */}
          <div className="shrink-0">
            <MyDetails game={game} />
          </div>
          {controls}
          {/* 下半：手牌拿走剩下的全部高度，牌多时自己滚 */}
          <div className="min-h-0 flex-1 overflow-y-auto">{hand}</div>
        </div>
        {overlays}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {table}
      {controls}
      {hand}
      {overlays}
    </div>
  );
}

// 牌桌中央右上角的倒计时（大号醒目；最后 10 秒变红，提示音在左栏组件内）。
//
// ⚠️ 每个有服务端兜底的「等一个人」的阶段都必须在这里显示倒计时。
// 看不见的超时是陷阱 —— 换底到点会自动埋 8 张，庄家要是没看到表，
// 只会觉得「我的牌怎么自己没了」。有兜底就必须有表，两者一起加。
function timerSpecFor(game) {
  const round = game.round;
  if (!round) return null;
  if (game.phase === 'PLAYING' && !round.lastTrick && round.turnSeat !== null) {
    return { deadline: round.playDeadline, seat: round.turnSeat };
  }
  if (game.phase === 'KITTY_EXCHANGE') {
    return { deadline: round.kittyDeadline, seat: game.declarerSeat };
  }
  if (game.phase === 'DOMINANCE') {
    return { deadline: round.dominanceDeadline, seat: null };
  }
  // 本局最后一墩的停留（5 秒，有人按住则 60 秒）—— 有服务端兜底就必须有表。
  if (game.phase === 'PLAYING' && round.finalTrickPending) {
    return { deadline: round.settleDeadline, seat: null };
  }
  // 揭牌那 3 秒也归这里（Glen：「揭牌键右边的倒数去掉，桌面中间有倒数就行了」）。
  // ⚠️ 是【搬】不是【删】：服务端到点会自动替他摸牌，按这个函数上面那条铁律，
  // 有兜底就必须有表。原来表挂在揭牌键右边，现在统一收到牌桌中央。
  if (game.phase === 'REVEALING' && round.drawnCount < 100 && !round.trumpSuit) {
    return { deadline: round.drawDeadline, seat: round.revealTurnSeat };
  }
  return null;
}

function CenterTurnTimer({ game }) {
  const spec = timerSpecFor(game);
  const now = displayNow(game, useNow(!!spec, 300));
  const left = secondsLeft(spec?.deadline, now);
  if (!spec || left === null) return null;
  const player = spec.seat === null ? null : game.players.find(p => p.seat === spec.seat);
  const urgent = left <= 10;
  return (
    // 竖屏窄屏：横排的「⏱时间 + 人名」会横跨到顶部信息条上面，把「庄家：X」压住。
    // 改成上下两行并整体缩小，宽度收到 ~60px，就落在信息条右侧的空白里了。
    <div className="absolute right-3 top-3 z-10 flex items-center gap-2 compact:right-1 compact:top-1 compact:flex-col compact:items-end compact:gap-0.5">
      <span
        className={`rounded-full px-4 py-2 text-lg font-black shadow-lg compact:px-2 compact:py-0.5 compact:text-xs compact:leading-tight ${
          urgent ? 'bg-rose-500 text-white' : 'bg-black/50 text-amber-300'
        }`}
      >
        ⏱ {Math.floor(left / 60)}:{String(Math.ceil(left % 60)).padStart(2, '0')}
      </span>
      {player && (
        <span className="pill bg-black/50 text-white/80 compact:px-1.5 compact:py-0 compact:text-[10px] compact:leading-tight">
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
  const now = displayNow(game, useNow(true, 500));
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
  // ⚠️ 本局小结结束后服务端会把 round 清成 null（跨局状态整体重建），
  // READY_CHECK 这一段没有 round 可读。原来退回写死的「第 1 局 / 级牌 2」，
  // 看着像整局回档，要等全员准备完才跳回正常值。
  // 服务端的 nextRound 就是下一局的局号和级牌（和 beginRound 同一个纯函数），
  // 空窗期显示它，数值和随后真正开局完全一致，不会闪一下。
  const shown = round ?? game.nextRound;
  return (
    <div className="mb-2 flex flex-wrap items-center justify-center gap-2">
      <span className="pill bg-white/10 text-white/70">第 {shown.roundNumber} 局</span>
      <span className="pill bg-white/10 text-white/70">级牌：{rankLabel(shown.rankCard)}</span>
      <span className="pill bg-amber-400/15 text-amber-300">
        庄家：{declarer ? `${PLAYER_EMOJI[declarer.id]} ${declarer.nickname}` : '未定'}
      </span>
      {round && (game.phase === 'REVEALING' || game.phase === 'REVEAL_FIRST') && (
        <span className="pill bg-white/10 text-white/70">底牌 8 张</span>
      )}
    </div>
  );
}

function CenterInfo({ game, send }) {
  const [showHint, setShowHint] = useState(false);
  const round = game.round;
  const trumpSuit = round?.trumpSuit ?? null;
  const pts = round?.defenderTrickPoints ?? 0;
  const pct = Math.min(100, (pts / 80) * 100);
  const now = displayNow(game, useNow(game.phase === 'REVEALING'));
  const drawLeft = secondsLeft(round?.drawDeadline, now);
  const graceLeft = secondsLeft(round?.graceDeadline, now);

  return (
    <div className="flex h-44 w-60 flex-col items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-center compact:h-auto compact:w-40 compact:gap-1 compact:px-2 compact:py-1.5">
      {/* 窄屏不再单独占一行画大花色（Glen：「把上边那个大的花色符号取消」）——
          花色改成直接长在「主牌：♦ · 打 2」这一行里，放大加色，一行说完两件事。 */}
      <div
        className={`text-4xl font-black compact:hidden ${
          trumpSuit ? (suitRed(trumpSuit) ? 'text-rose-400' : 'text-white/90') : 'text-white/30'
        }`}
      >
        {trumpSuit ? suitSymbol(trumpSuit) : '?'}
      </div>
      <div className="text-xs font-bold text-white/60">
        {round ? (
          trumpSuit ? (
            <>
              主牌：
              <span
                className={`align-middle text-2xl font-black ${
                  suitRed(trumpSuit) ? 'text-rose-400' : 'text-white/90'
                }`}
              >
                {suitSymbol(trumpSuit)}
              </span>
              {` · 打 ${rankLabel(round.rankCard)}`}
            </>
          ) : (
            `打 ${rankLabel(round.rankCard)} · 主牌未定`
          )
        ) : (
          '未开局'
        )}
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
      {/* 窄屏把进度条收窄一半：它只是个粗略的观感刻度，旁边那个「闲家 40 / 80」
          才是准数（Glen：「把进度条缩短」）。 */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10 compact:w-2/3">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-rose-400 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* 阶段说明：竖屏窄屏空间宝贵，整段文字换成一个「说明」小按钮，点开才看 */}
      <div className="text-xs font-bold text-white/70 compact:hidden">
        {PHASE_HINTS[game.phase]}
      </div>
      {/* 窄屏：托管和说明并成一行（Glen）—— 各占一行太浪费，这两个都是小按钮 */}
      <div className="hidden items-center gap-1.5 compact:flex">
        <AutoPlayToggle game={game} send={send} />
        <button
          type="button"
          className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-black text-white/70"
          onClick={() => setShowHint(true)}
        >
          说明
        </button>
      </div>
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

// 碾压判定面板：摊开四家剩余手牌 + 说明 + 看结算 / 看多一会
//
// Glen：「这个时间太短了，应该只有 1 秒，至少要 5 秒，也同样加一个『看多一会』
//   的按钮，30 秒。」原因不在这个面板 —— 是【电脑一进这个阶段就替你点了确认】，
//   一家点就结束。两头都改了：bot-policy 里只有四家全是电脑才立刻点，
//   服务端默认停 5 秒（DOMINANCE_MS），按了这里的按钮拉到 30 秒。
// 倒计时不画在这里：牌桌中央那块表已经挂着 dominanceDeadline（timerSpecFor）。
function DominancePanel({ game, send }) {
  const dom = game.round?.dominance;
  const hands = game.round?.allHandsRevealed ?? [];
  const you = game.you;
  const holds = game.round?.dominanceHolds ?? [];
  const iHold = holds.includes(you?.seat);
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
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button className="btn-gold" onClick={() => send({ type: 'confirmDominance' })}>
            看结算
          </button>
          <button
            className={iHold ? 'btn-gold' : 'btn-emerald'}
            onClick={() => send({ type: iHold ? 'releaseDominance' : 'holdDominance' })}
          >
            {iHold ? '继续（我看完了）' : '看多一会'}
          </button>
        </div>
        {holds.length > 0 && (
          <p className="mt-2 text-center text-xs font-bold text-emerald-300/80">
            {holds
              .map(seat => game.players.find(p => p.seat === seat)?.nickname ?? '—')
              .join('、')}
            {' '}还在看，等他{holds.length > 1 ? '们' : ''}按「继续」
          </p>
        )}
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
      {/* ⚠️ max-h-full + overflow-y-auto：手机横屏只有 390px 高，这个面板的内容
          （三块分数 + 底牌 + 结论 + 复盘要点）远不止这么高，不给滚动就直接被裁掉，
          底下的按钮也点不到（Glen 截图）。DominancePanel 早就是这么写的，
          这里一直漏着。窄屏顺带把内边距收一收。 */}
      <div className="panel max-h-full w-[min(94%,440px)] overflow-y-auto p-5 compact:p-3">
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
  const now = displayNow(game, useNow(true, 500));
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
  const compact = useMediaQuery(COMPACT);
  const round = game.round;
  if (!round || game.phase !== 'PLAYING' && game.phase !== 'DOMINANCE') return null;
  const total = round.kittyCount ?? 0;
  if (total <= 0) return null;
  const revealed = round.kittyRevealedPieces ?? [];

  // 窄屏（手机竖屏 / 手机横屏）：底牌这一块只保留两个信息 ——
  // 一共几张、亮出来的是哪几支件。件用「♠A」这样一个字宽的标签，不画整张牌面
  //（Glen：「底牌也精简，只要露出 ♠A 像这样的单个字的件就行，牌也尽量小」）。
  // 牌背保留但换到最小的 xs 档、叠得更紧 —— 它只需要传达"底牌还压着这么多张"。
  if (compact) {
    return (
      <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/25 px-1.5 py-0.5">
        <div className="flex">
          {Array.from({ length: total }, (_, i) => (
            <PlayingCard
              key={`kitty-${i}`}
              suit={null}
              rank={null}
              faceUp={false}
              size="xs"
              className="-ml-[1.05rem] first:ml-0"
            />
          ))}
        </div>
        {revealed.map((piece, i) => (
          <span
            key={`p-${i}`}
            className={`rounded px-1 text-[10px] font-black leading-tight ${
              suitRed(piece.suit) ? 'bg-rose-400/20 text-rose-300' : 'bg-white/15 text-white/85'
            }`}
            title={`底牌亮出：${suitSymbol(piece.suit)}${rankLabel(piece.rank)}`}
          >
            {suitSymbol(piece.suit)}{rankLabel(piece.rank)}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/25 px-3 py-1.5 compact:gap-1 compact:px-1.5 compact:py-1">
      <span className="text-[10px] font-bold text-white/40 compact:hidden">底牌</span>
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
              className="-ml-3 first:ml-0 compact:-ml-[1.35rem]"
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
  // 手机横屏牌桌只占 40% 宽、390px 高，xl（h-24 w-16）实在太大（Glen：
  // 「把左边的牌给缩小 1 到 2 号吧，还是大了，仅限横屏版」）。小两档到 md。
  // ⚠️ 叠放量要跟着牌宽一起改：-ml-12 是按 xl 的 64px 宽调的（露出 16px），
  // 直接套到 44px 宽的 md 上会把牌盖得只剩一条缝。
  const smallPlay = useMediaQuery(PHONE_LANDSCAPE);
  const playSize = smallPlay ? 'md' : 'xl';
  const overlapMany = smallPlay ? '-ml-[38px]' : '-ml-[54px]';
  const overlapFew = smallPlay ? '-ml-8' : '-ml-12';
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

  // 「还在等谁」——只取还没好的那一半，确认态不上牌桌（见 seatStatus.js）
  const pendingText = seatPendingText(game, player);

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
      {/* 被大鬼压制那家的回嘴（捏一个吉 / 谱依阿姨 / 小到下）。
          再高一档：同一家可能先用大鬼压过人（pudiao）、随后又被更大的压回来。 */}
      {play?.beatenEgg && (
        <div className="beaten-bubble absolute -top-[6.5rem] left-1/2 z-30 -translate-x-1/2">
          {play.beatenEgg}
        </div>
      )}
      <div className="flex items-center gap-1 text-xs font-black text-white/80">
        {/* 「电脑」放在名字【前面】（Glen）：牌桌上一眼扫过去先看到的是这两个字，
            立刻知道这一家是电脑在打，不用去读完名字再找后缀。
            左栏玩家列表里也有同样的标记，但手机竖屏时那栏藏在 👥 浮层里 ——
            标记只放那儿等于看不见，和「托管中」当初的理由一样。 */}
        {player.isBot && (
          <span className="rounded bg-cyan-400/25 px-1 text-[10px] leading-tight text-cyan-200">
            电脑
          </span>
        )}
        {/* 手机竖屏把【自己】的名字藏起来（Glen）：这一格贴着控制栏，
            「半仙(我)」正好压在揭牌键上。名字改到手牌区右下角去显示 ——
            那里本来就是自己的地盘，也不会挡住任何人。
            ⚠️ 只藏名字文本，后面的「亮X」「🏆/👑」照留：那几个是随时在变的
            局面信息，不能跟着一起没掉。 */}
        <span className={isYou ? 'compact:hidden' : undefined}>
          {PLAYER_EMOJI[player.id]} {player.nickname}
          {isYou ? '(我)' : ''}
        </span>
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
      {/* 托管标记也要出现在【牌桌上】的名字下面：
          手机竖屏时左栏玩家列表是藏在 👥 浮层里的，标记只放那儿等于看不见。
          牌桌是所有人一直盯着的地方，做得小而醒目，不占额外行高。 */}
      {player.autoPlay && !player.isBot && (
        <div
          className="rounded-full bg-cyan-400/90 px-1.5 text-[10px] font-black leading-[1.35] text-cyan-950"
          title={`${player.nickname} 已开启电脑托管，由 AI 代打`}
        >
          🤖 托管中
        </div>
      )}
      {/* 「未准备」等等也要在牌桌上（Glen）：等人点的阶段（准备/起揭停留/小结/换底/
          过河）四个人干等着，不该只有点开左栏浮层才知道还差谁。
          只显示【还没好】的那一半，确认态不占位。 */}
      {pendingText && (
        <div className="rounded-full bg-amber-400/85 px-1.5 text-[10px] font-black leading-[1.35] text-amber-950">
          {pendingText}
        </div>
      )}
      {/* 出牌区自适应：没牌时只剩方位名一条细线；有牌按张数展开（容量 10 张，超出再压缩） */}
      {hasPlay && (
        <div className="relative flex items-center justify-center">
          {/* 甩牌张数角标：多张时牌是叠着的，光看牌面数不清到底甩了几张 —— 
              而张数正是跟牌方必须凑够的数量，是这一墩最关键的信息。
              单张不显示（一张牌不用标 1）。 */}
          {play.cards.length > 1 && (
            <span
              className="pointer-events-none absolute -right-1.5 -top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full bg-amber-400 text-xs font-black text-amber-950 shadow-md shadow-black/40 compact:-right-1 compact:-top-1 compact:h-5 compact:w-5 compact:text-[10px]"
              title={`甩了 ${play.cards.length} 张`}
            >
              {play.cards.length}
            </span>
          )}
          {/* 左右两侧在竖屏手机上改为竖向叠放：竖屏横向空间本来就窄，
              甩牌多张时横排会把中间牌桌挤没。单张时横竖一样，无影响。
              仅限竖屏 + 窄屏，横屏和桌面保持原来的横排。 */}
          <div className={`flex ${sideways ? 'compact:flex-col' : ''}`}>
            {play.cards.map((c, i) => (
              <PlayingCard
                key={c.id}
                suit={c.suit}
                rank={c.rank}
                size={playSize}
                className={`card-pop ${
                  i === 0
                    ? ''
                    : sideways
                      // ⚠️ 竖向叠放那两个类【必须写成完整字面量】：Tailwind 是扫源码文本
                      // 生成 CSS 的，拼出来的 `compact:${...}` 它认不出，样式根本不会生成。
                      ? `${play.cards.length > 10 ? overlapMany : overlapFew} compact:ml-0 ${
                          smallPlay ? 'compact:-mt-12' : 'compact:-mt-[4.5rem]'
                        }`
                      : play.cards.length > 10
                        ? overlapMany
                        : overlapFew
                }`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// compact = 手机横屏。高度是那套版式里最紧的资源，控制栏得收窄：
// 去掉上下 padding、行距压到最小，按钮本身不动（拇指还要点得到）。
function ControlBar({ game, send, error, selected, onClear, onDeclareOptions, onTogglePlayers, onToggleChat, compact = false }) {
  const you = game.you;
  const round = game.round;
  // 注：原来这里有个 useNow(REVEALING) 只为了驱动揭牌键旁边那个 0.1 秒精度的倒计时。
  // 倒计时搬去牌桌中央之后，整条控制栏不必再每帧重渲染了。
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
    // 亮主：手里有未亮出的级牌即可按（与揭牌回合无关，宽限窗口内同样可用）
    const rankCards = (you.hand ?? []).filter(c => c.rank === round.rankCard);
    // 亮主【放在揭牌上边】，而且换成绿色（Glen）。
    // 两件事一起做才有意义：这两个按钮同时出现、又是完全不同的动作
    //（揭牌是轮到我才能按的流程键，亮主是随时能按的决断键），
    // 并排 + 同色最容易按错。上下分开 + 分色，手指和眼睛都不会混。
    // 倒计时不再插在两者之间 —— 它搬去牌桌中央了。
    buttons.push(
      <div key="reveal" className="flex flex-col items-center gap-2">
        {rankCards.length > 0 && (
          <button
            key="declare"
            className="btn-emerald"
            onClick={() => {
              const suits = [...new Set(rankCards.map(c => c.suit))];
              if (suits.length === 1) send({ type: 'declareTrump', cardId: rankCards[0].id });
              else onDeclareOptions(rankCards);
            }}
          >
            亮主{rankCards.length > 1 ? `（按 1~${rankCards.length} 直接亮）` : '（按 1 直接亮）'}
          </button>
        )}
        <button
          key="draw"
          className="btn-gold"
          disabled={!myTurn}
          onClick={() => send({ type: 'drawCard' })}
        >
          {myTurn ? '揭牌（空格）' : `等待 ${drawer?.nickname ?? '—'} 揭牌`}
        </button>
      </div>
    );
  } else if (game.phase === 'PLAYING' && round?.finalTrickPending) {
    // 本局最后一墩的停留（Glen）：
    //   「就是自动打出那个面板，至少设成停 5 秒，原来可能 1 秒都还没到。
    //     加一个『我想再看一会』的按钮，如果没人按，那就 5 秒关，
    //     如果有人按，那么会等他按继续才关，倒数 60 秒。」
    // 这一墩是四家各剩一张自动打出的、决定撬底，最该看清楚。
    const holds = round.lastTrickHolds ?? [];
    const iHold = holds.includes(you.seat);
    buttons.push(
      <button
        key="hold"
        className={iHold ? 'btn-gold' : 'btn-emerald'}
        onClick={() => send({ type: iHold ? 'releaseLastTrick' : 'holdLastTrick' })}
      >
        {iHold ? '继续（我看完了）' : '我想再看一会'}
      </button>
    );
    if (holds.length > 0) {
      const names = holds
        .map(seat => game.players.find(p => p.seat === seat)?.nickname ?? '—')
        .join('、');
      hints.push(
        <span key="holders" className="text-xs font-bold text-emerald-300/80">
          {names} 还在看这一墩，等他{holds.length > 1 ? '们' : ''}按「继续」
        </span>
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
      // 明说超时会发生什么。服务端到点会替他埋「最没用的 8 张」，
      // 不提前讲清楚，庄家只会觉得牌自己没了。
      hints.push(
        <span key="bury-timeout" className="text-xs font-bold text-white/50">
          超时未埋将自动埋掉最没用的 8 张
        </span>
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
    <div className={`flex shrink-0 flex-col items-center ${compact ? 'gap-1 py-0.5' : 'gap-1.5 py-2'}`}>
      {/* 窄屏的左右栏开关跟在主按钮两侧：原来钉在屏幕两个下角，正好压着手牌。
          平时 70% 不透明不抢戏，碰到/按下才实心。
          显示条件沿用原来的断点：玩家列表 <768px 才需要，聊天 <1024px 才需要。 */}
      <div className="relative flex w-full items-center justify-center gap-3">
        {onTogglePlayers && (
          // ⚠️ 横屏时不能挂 md:hidden：手机横过来宽度 800+，那个类会把开关藏掉，
          // 而左栏这时候恰恰是收起来的 —— 玩家列表就彻底没入口了。
          <button
            type="button"
            className={`btn-float-sm absolute left-0 ${compact ? '' : 'md:hidden'}`}
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
            className={`btn-float-sm absolute right-0 ${compact ? '' : 'lg:hidden'}`}
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
// className：手机横屏那套版式要它把剩下的高度吃满，好让手牌区的底线和左边
// 牌桌那一栏对齐（Glen：「手牌区的底线和桌面区的底线不一致」）。
// 不加的话外层容器撑满了、里面这块面板还是内容高度，实测差 42px。
function HandArea({ game, send, selected, onToggle, onDragAdd, onToggleGroup, onDeclareRank, className = '' }) {
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
  // 与 CSS 的 compact: 断点保持一致（手机竖屏 + iPad 竖屏）。
  const compactPortrait = useMediaQuery(COMPACT_PORTRAIT);
  // 手机横屏。
  //
  // ⚠️ 这里【去掉过最大那一档】（Glen 先说「手牌区的牌也小一号试试」），
  // 看了实机之后他又要回来：「手牌区的牌可以大一号，也是仅限横屏牌」。
  // 所以档位表和宽屏一样，三档全给 —— 手牌区在横屏拿的是剩余高度（flex-1），
  // 空间够就该用大的，不够时择优逻辑本来就会自己降档。别再写死砍掉最大档。
  const phoneLandscapeHand = useMediaQuery(PHONE_LANDSCAPE);
  const tiers = HAND_TIERS;
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
      const t0 = tiers[0];
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
      for (const tier of tiers) {
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
    const tier = tiers[tiers.length - 1];
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
  const segW = layout?.w ?? tiers[0].w;
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
    <div className={`relative rounded-2xl border border-white/10 bg-black/15 p-2 compact:p-1.5 ${className}`}>
      {/* 自己的名字（手机竖屏专用）—— 牌桌上那一格贴着控制栏，名字会压住揭牌键，
          所以搬到这里：手牌区右下角，自己的地盘。
          ⚠️ z-0 是【故意的】：牌行是 z-10，牌多到铺过来时直接盖在名字上层
          （Glen：「有牌在上边的话就把牌叠在上层」）。名字只是个落款，
          不能反过来挡住牌面 —— 手牌右下角正好是最后一张牌露出点数的地方。 */}
      <div className="pointer-events-none absolute bottom-1.5 right-3 z-0 hidden text-xs font-black text-white/45 compact:block">
        {PLAYER_EMOJI[you.id]} {you.nickname}(我)
      </div>
      {/* ⚠️ 平时【不写】「我的手牌」四个字（Glen：「把"我的手牌"字样取消」）——
          自己的手牌摆在自己面前，本来就不用标注；那一行的高度留给牌。
          换底 / 过河这类【要你照着做】的提示仍然要出，那不是标签是指令。 */}
      <div className="mb-1 flex items-center justify-between text-xs font-bold text-white/50 compact:mb-0">
        <span>
          {exchangeSelectable
            ? `手牌 + 底牌（点选 8 张埋回，已选 ${selected.length}/8）`
            : crossSelectable
              ? cross.mustRespond
                ? `回给对家：点选 3 张副牌（已选 ${selected.length}/3）`
                : `过河送出：全部主牌 + 副牌补足 3 张（已选 ${selected.length}/3）`
              : ''}
        </span>
        <span className="flex items-center gap-2">
          {/* 竖屏窄屏这里空间紧张，托管按钮改挂到中央信息区（「说明」上边） */}
          <AutoPlayToggle game={game} send={send} className="compact:hidden" />
          <span>{hand.length} 张</span>
        </span>
      </div>
      {hand.length === 0 ? (
        <div className="relative z-10 flex min-h-24 items-center justify-center gap-2">
          <PlayingCard suit={null} rank={null} faceUp={false} className="opacity-40" />
          <span className="text-xs font-bold text-white/40">揭牌后手牌显示在这里</span>
        </div>
      ) : (
        /* 固定重叠 + 左对齐：牌始终叠在一起靠左排，视口再宽也不摊开、不右移。
           顶部预留抬起 + 角标空间（pt-5），不设 overflow hidden，避免抬起的牌被裁掉。
           窄屏收到 pt-3、底部去掉 pb —— 牌尽量往上贴（Glen），
           底线也才和左边牌桌那一栏对得齐。 */
        <div ref={rowRef} className="relative z-10 flex flex-col gap-1 pb-2 pt-5 compact:pb-0 compact:pt-3">
          {rowChunks.map((chunk, i) => (
            <div
              key={i}
              // 窄屏一律居中（Glen：「所有手牌居中」）。宽屏保持左对齐 ——
              // 那边是刻意的锚定：打掉牌只是行尾变短，已出的牌左侧位置纹丝不动。
              className={`flex items-end ${
                compactPortrait || phoneLandscapeHand ? 'justify-center' : 'justify-start'
              }`}
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
