import { useEffect, useState } from 'react';
import { PLAYER_EMOJI } from '../utils.js';

const IDENTITIES = [
  { id: 'T', nickname: '勝' },
  { id: 'H', nickname: '麤' },
  { id: 'B', nickname: '半仙' },
  { id: 'M', nickname: '旻' },
];

// 身份选择模态框：已被占用的身份置灰不可选
export default function IdentityModal({ notice, onPick }) {
  const [occupied, setOccupied] = useState([]);
  const [bots, setBots] = useState([]);

  useEffect(() => {
    let timer;
    const poll = async () => {
      try {
        const res = await fetch('/api/occupancy');
        const data = await res.json();
        setOccupied(data.occupied ?? []);
        setBots(data.bots ?? []);
      } catch {
        /* 网络未就绪时忽略 */
      }
      timer = setTimeout(poll, 2000);
    };
    poll();
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="grid h-screen place-items-center">
      <div className="panel w-[min(92vw,420px)] p-6 text-center">
        <h1 className="text-2xl font-black text-amber-300">潮汕升级</h1>
        <p className="mt-1 text-sm font-bold text-white/60">选择你的身份进入房间</p>
        {notice && (
          <div className="mt-3 rounded-full bg-rose-500/20 px-4 py-1.5 text-sm font-bold text-rose-200">
            {notice}
          </div>
        )}
        <div className="mt-5 grid grid-cols-2 gap-3">
          {IDENTITIES.map(({ id, nickname }) => {
            const busy = occupied.includes(id);
            const isBot = bots.includes(id);
            return (
              <button
                key={id}
                disabled={busy}
                onClick={() => onPick(id)}
                className="flex flex-col items-center gap-1 rounded-2xl border border-white/10 bg-white/5 p-4 font-bold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="text-3xl">{PLAYER_EMOJI[id]}</span>
                <span>{nickname}</span>
                <span className="text-xs text-white/50">
                  {isBot ? '电脑控制' : busy ? '已在房间' : `身份 ${id}`}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-4 text-xs font-bold text-white/40">
          也可通过邀请链接 ?USER=T 直接进入
        </p>
      </div>
    </div>
  );
}
