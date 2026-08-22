import { useState } from 'react';
import { useNow, secondsLeft, displayNow } from '../useNow.js';
import Modal from './Modal.jsx';

// 新开一局相关弹窗（统一走 Modal portal 路径）：
// - ResetProposalModal：提案进行中的投票/进度（非发起者未投票时需点同意/拒绝）
// - ProposeResetModal：发起提案（含座位选项）
// - ForceResetModal：管理员强制重置（danger：必须显式点按钮）

export function ResetProposalModal({ game, send, onClose }) {
  const p = game.resetProposal;
  if (!p) return null;
  const me = game.you;
  const initiator = game.players.find(x => x.seat === p.fromSeat);
  const voted = p.yesSeats.includes(me.seat);
  const now = displayNow(game, useNow(true, 500));
  const left = secondsLeft(p.deadline, now);
  return (
    <Modal title="新开一局提案" onClose={onClose}>
      <p className="text-sm font-bold text-white/80">
        <span className="text-amber-300">{initiator?.nickname}</span> 提议新开一局（
        {p.reshuffleSeats ? '重新随机座位' : '保留座位'}），当前战绩将清空。
      </p>
      <div className="mt-3 text-center">
        <span className="pill bg-amber-400/15 text-amber-300">{p.yesSeats.length}/4 已同意</span>
        {left !== null && (
          <span className="ml-2 pill bg-white/10 text-white/60">⏱ {Math.ceil(left)}s 超时取消</span>
        )}
      </div>
      {voted ? (
        <p className="mt-3 text-center text-xs font-bold text-white/50">你已同意，等待其他人…</p>
      ) : (
        <div className="mt-4 flex justify-center gap-3">
          <button className="btn-gold" onClick={() => send({ type: 'voteReset', agree: true })}>
            同意
          </button>
          <button
            className="rounded-full bg-rose-500 px-6 py-2.5 font-black text-white transition hover:brightness-110"
            onClick={() => send({ type: 'voteReset', agree: false })}
          >
            拒绝
          </button>
        </div>
      )}
    </Modal>
  );
}

export function ProposeResetModal({ game, send, onClose }) {
  const [reshuffle, setReshuffle] = useState(false);
  return (
    <Modal title="提议新开一局" onClose={onClose}>
      <p className="text-sm font-bold text-white/70">
        发起后需四人全部同意才执行（你视为已同意）；任一人拒绝即取消；60 秒无人响应自动取消。
      </p>
      <div className="mt-3 space-y-2 text-sm font-bold text-white/70">
        <label className="flex items-center gap-2">
          <input type="radio" checked={!reshuffle} onChange={() => setReshuffle(false)} />
          保留座位（默认，直接进入准备）
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={reshuffle} onChange={() => setReshuffle(true)} />
          重新随机座位（重新换座确认）
        </label>
      </div>
      <div className="mt-4 flex justify-center gap-2">
        <button
          className="btn-gold"
          onClick={() => {
            send({ type: 'proposeReset', reshuffleSeats: reshuffle });
            onClose();
          }}
        >
          发起提案
        </button>
        <button className="rounded-full bg-white/10 px-4 py-2.5 text-sm font-bold text-white/70" onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  );
}

export function ForceResetModal({ game, send, onClose }) {
  const [reshuffle, setReshuffle] = useState(false);
  return (
    <Modal title="强制重置" onClose={onClose} danger>
      <p className="text-sm font-bold text-rose-200">
        ⛔ 将跳过其他人的同意，立即清空级别、局数与存档。确定？
      </p>
      <div className="mt-3 space-y-2 text-sm font-bold text-white/70">
        <label className="flex items-center gap-2">
          <input type="radio" checked={!reshuffle} onChange={() => setReshuffle(false)} />
          保留座位
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={reshuffle} onChange={() => setReshuffle(true)} />
          重新随机座位
        </label>
      </div>
      <div className="mt-4 flex justify-center gap-2">
        <button
          className="rounded-full bg-rose-500 px-6 py-2.5 font-black text-white transition hover:brightness-110"
          onClick={() => {
            send({ type: 'forceReset', reshuffleSeats: reshuffle });
            onClose();
          }}
        >
          确定强制重置
        </button>
        <button className="rounded-full bg-white/10 px-4 py-2.5 text-sm font-bold text-white/70" onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  );
}
