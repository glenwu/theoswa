import { useEffect, useRef, useState } from 'react';
import { createConnection } from './net.js';
import IdentityModal from './components/IdentityModal.jsx';
import PlayerPanel from './components/PlayerPanel.jsx';
import TablePanel from './components/TablePanel.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import { ResetProposalModal } from './components/ResetModals.jsx';
import Modal from './components/Modal.jsx';
import { PLAYER_EMOJI } from './utils.js';

const VALID_IDS = ['T', 'H', 'B', 'M'];

const PHASE_NAMES = {
  SEATING: '换座阶段',
  READY_CHECK: '准备阶段',
  REVEAL_FIRST: '抢按揭牌',
  REVEALING: '揭牌定主',
  FALLBACK_TRUMP: '揭底定主',
  DEALING: '发牌中',
  KITTY_EXCHANGE: '庄家换底',
  CROSS_RIVER: '三主过河',
  PLAYING: '出牌',
  SCORING: '结算',
  ROUND_END: '本局结束',
  GAME_OVER: '游戏结束',
};

// 页面标题随状态实时更新：轮到自己 / 轮到别人 / 阶段名
function titleFor(game) {
  if (!game) return '潮汕升级';
  const you = game.you;
  const round = game.round;
  const me = game.players.find(p => p.seat === you.seat);
  if (game.phase === 'PLAYING' && round && !round.lastTrick) {
    if (round.turnSeat === you.seat) return '★ 该你了 · 潮汕升级';
    const turn = game.players.find(p => p.seat === round.turnSeat);
    if (turn) return `轮到${turn.nickname} · 潮汕升级`;
  }
  if (game.phase === 'REVEALING' && round && round.drawnCount < 100 && !round.trumpSuit) {
    if (round.revealTurnSeat === you.seat) return '★ 该你揭牌 · 潮汕升级';
    const turn = game.players.find(p => p.seat === round.revealTurnSeat);
    if (turn) return `轮到${turn.nickname}揭牌 · 潮汕升级`;
  }
  if (game.phase === 'KITTY_EXCHANGE' && game.declarerSeat === you.seat) {
    return '★ 该你换底 · 潮汕升级';
  }
  return `${PHASE_NAMES[game.phase] ?? game.phase} · 潮汕升级`;
}

export default function App() {
  const [identity, setIdentity] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('USER');
    return p && VALID_IDS.includes(p) ? p : null;
  });
  const [game, setGame] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const connRef = useRef(null);

  useEffect(() => {
    if (!identity) return;
    // 记住身份：刷新 / 分享链接可直接进入
    const url = new URL(window.location.href);
    url.searchParams.set('USER', identity);
    window.history.replaceState(null, '', url.toString());

    // 管理员口令：?RESET=<服务端 ADMIN_RESET_TOKEN> 时随 join 上报
    const adminToken = new URLSearchParams(window.location.search).get('RESET') ?? undefined;

    const conn = createConnection(identity, {
      onState: setGame,
      onError: (e) => setError(e),
      onKicked: (reason) => {
        setNotice(reason);
        setGame(null);
        setIdentity(null);
      },
      joinPayload: adminToken !== undefined ? { adminToken } : {},
    });
    connRef.current = conn;
    return () => conn.close();
  }, [identity]);

  // 每个动作都带上客户端已知的 phase：
  // 服务端发现不一致会返回 STALE_STATE（陈旧界面点击不会静默生效/吞掉）
  const send = (action) => connRef.current?.send({ ...action, phase: game?.phase });

  // 页面标题随状态实时更新（多标签页切走也能看出轮到谁）
  useEffect(() => {
    document.title = titleFor(game);
  }, [game]);

  if (!identity) {
    return <IdentityModal notice={notice} onPick={setIdentity} />;
  }
  if (!game) {
    return (
      <div className="grid h-screen place-items-center font-bold text-white/80">
        正在连接房间…
      </div>
    );
  }

  return <GameLayout game={game} send={send} error={error} />;
}

function GameLayout({ game, send, error }) {
  const [showChat, setShowChat] = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);
  // 提案弹窗可关闭（未投票时关闭视为弃权，等待超时）
  const [proposalDismissed, setProposalDismissed] = useState(false);
  useEffect(() => {
    setProposalDismissed(false);
  }, [game?.resetProposal]);

  // 换座请求（阶段7）：全屏确认对话框，同意/拒绝必须显式选择
  const incomingSwap = game.swapProposals.find(sp => sp.toSeat === game.you.seat);

  return (
    <div className="flex h-screen w-full gap-2 overflow-hidden p-2">
      {/* 新开一局提案：全局全屏弹窗（portal 到 body） */}
      {game.resetProposal && !proposalDismissed && (
        <ResetProposalModal game={game} send={send} onClose={() => setProposalDismissed(true)} />
      )}

      {/* 换座请求：全局全屏确认（portal 到 body） */}
      {incomingSwap && (
        <SwapConfirmModal game={game} swap={incomingSwap} send={send} />
      )}

      {/* 左栏：玩家列表（220px） */}
      <aside className="hidden w-[220px] shrink-0 md:block">
        <PlayerPanel game={game} send={send} />
      </aside>

      {/* 中栏：牌桌 + 手牌 */}
      <main className="min-w-0 flex-1">
        <TablePanel game={game} send={send} error={error} />
      </main>

      {/* 右栏：消息与聊天（300px，消息多换行没关系——本来就是可滚动的流水账） */}
      <aside className="hidden w-[300px] shrink-0 lg:block">
        <ChatPanel game={game} send={send} />
      </aside>

      {/* 窄屏浮层开关（拇指可点的 56px 大按钮） */}
      <button
        className="btn-float fixed bottom-4 left-4 z-40 md:hidden"
        onClick={() => setShowPlayers(v => !v)}
      >
        👥
      </button>
      <button
        className="btn-float fixed bottom-4 right-4 z-40 lg:hidden"
        onClick={() => setShowChat(v => !v)}
      >
        💬
      </button>
      {showPlayers && (
        <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={() => setShowPlayers(false)}>
          <div className="h-full w-64 p-2" onClick={e => e.stopPropagation()}>
            <PlayerPanel game={game} send={send} />
          </div>
        </div>
      )}
      {showChat && (
        <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setShowChat(false)}>
          <div className="ml-auto h-full w-80 p-2" onClick={e => e.stopPropagation()}>
            <ChatPanel game={game} send={send} />
          </div>
        </div>
      )}
    </div>
  );
}

// 换座请求全屏确认（阶段7）：同意 / 拒绝必须显式点按钮（danger 模式：遮罩与 ESC 不关闭）
function SwapConfirmModal({ game, swap, send }) {
  const from = game.players.find(p => p.seat === swap.fromSeat);
  return (
    <Modal title={`${from?.nickname ?? ''} 想和你换座位`} danger>
      <div className="flex flex-col items-center gap-3 py-2">
        <div className="text-3xl">
          {from && (
            <>
              <span className="mr-2">{PLAYER_EMOJI[from.id]}</span>
              <span className="font-black text-amber-200">{from.nickname}</span>
            </>
          )}
          <span className="mx-2 text-white/50">⇄</span>
          <span className="font-black text-amber-200">你</span>
        </div>
        <p className="text-sm font-bold text-white/60">交换后队伍随座位重算（team = seat % 2）</p>
        <div className="mt-2 flex gap-3">
          <button className="btn-gold" onClick={() => send({ type: 'acceptSwap', fromSeat: swap.fromSeat })}>
            同意
          </button>
          <button className="btn-gold-sm" onClick={() => send({ type: 'declineSwap', fromSeat: swap.fromSeat })}>
            拒绝
          </button>
        </div>
      </div>
    </Modal>
  );
}
