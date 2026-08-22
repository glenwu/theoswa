import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PLAYER_EMOJI } from '../utils.js';
import { nextOnlineToasts, onlineKey } from '../onlineToast.js';

// 单条提示的停留时间；多条时依次消失（先来的先走）
const TOAST_MS = 5000;

// 真人上线的下拉提示：从屏幕顶部滑下，几秒后自动收走。
// 「哪些算新的」全部交给 onlineToast.js 的纯函数处理（首帧基线 + 去重），
// 这里只负责渲染和计时。
export default function OnlineToast({ game }) {
  const [toasts, setToasts] = useState([]);
  // null = 还没建立基线（首帧）。用 ref 而不是 state：它的变化不该触发重渲染。
  const seenRef = useRef(null);

  const log = game?.log;
  const selfId = game?.you?.id;

  useEffect(() => {
    const { fresh, seen } = nextOnlineToasts(log, selfId, seenRef.current);
    seenRef.current = seen;
    if (fresh.length > 0) setToasts(prev => [...prev, ...fresh]);
  }, [log, selfId]);

  // 队首到点就出队。依赖 toasts 本身：每次队列变化都重新计时，
  // 保证连着上线两个人时第二条也有完整的停留时间。
  useEffect(() => {
    if (toasts.length === 0) return undefined;
    const timer = setTimeout(() => setToasts(prev => prev.slice(1)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;

  const nameOf = id => game.players.find(p => p.id === id)?.nickname ?? id;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-1.5 px-2"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
    >
      {toasts.map(t => (
        <div
          key={onlineKey(t)}
          className="online-toast flex max-w-[92vw] items-center gap-2 rounded-full border border-gold-300/40 bg-felt-800/95 px-4 py-2 shadow-lg shadow-black/50 backdrop-blur"
        >
          <span className="text-xl leading-none">{PLAYER_EMOJI[t.playerId] ?? '👋'}</span>
          <span className="truncate text-sm font-black text-gold-300">{nameOf(t.playerId)}</span>
          <span className="whitespace-nowrap text-sm font-bold text-white/80">
            已上线，大家欢迎！
          </span>
        </div>
      ))}
    </div>,
    document.body
  );
}
