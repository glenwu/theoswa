import Modal from './Modal.jsx';
import { useNow } from '../useNow.js';
import { PLAYER_EMOJI } from '../utils.js';

function elapsedText(since, now) {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

// 暂停弹窗：谁暂停的 + 任何真人都能恢复。
// danger 模式（遮罩与 ESC 都不关闭）—— 暂停期间服务端拒绝一切推进牌局的动作，
// 让人把弹窗关掉却继续对着一个动不了的牌桌点，只会更困惑。
export default function PauseModal({ game, send }) {
  const paused = game.paused;
  const now = useNow(!!paused, 1000);
  if (!paused) return null;

  const by = paused.bySeat === null
    ? null
    : game.players.find(p => p.seat === paused.bySeat);

  return (
    <Modal title="⏸ 游戏已暂停" danger>
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        {paused.auto ? (
          <>
            <p className="text-lg font-black text-amber-200">真人玩家已全部离线</p>
            <p className="text-sm font-bold text-white/60">
              牌局已自动暂停，免得四个电脑自顾自把这局打完。
            </p>
          </>
        ) : (
          <p className="text-lg font-black text-amber-200">
            {by ? (
              <>
                <span className="mr-1">{PLAYER_EMOJI[by.id]}</span>
                {by.nickname}
              </>
            ) : '有人'}{' '}
            暂停了游戏
          </p>
        )}

        <p className="text-sm font-bold text-white/50">
          已暂停 {elapsedText(paused.at, now)} · 所有倒计时都停住了，恢复后接着走
        </p>

        <button className="btn-gold mt-1" onClick={() => send({ type: 'resume' })}>
          ▶ 恢复游戏
        </button>
        <p className="text-xs font-bold text-white/40">任何真人玩家都可以恢复</p>
      </div>
    </Modal>
  );
}
