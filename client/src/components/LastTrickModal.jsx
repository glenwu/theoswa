import Modal from './Modal.jsx';
import { PlayingCard } from './PlayingCard.jsx';
import { PLAYER_EMOJI } from '../utils.js';
import { lastTrickRows } from '../lastTrickView.js';
import { tableSeats } from '../seatPositions.js';

const POSITION_NAMES = { top: '对家', left: '上家', right: '下家', self: '我' };

export default function LastTrickModal({ game, trick, onClose }) {
  const rows = lastTrickRows(trick);
  const playerAt = seat => game.players.find(player => player.seat === seat);
  const winner = playerAt(trick.winnerSeat);
  return (
    <Modal title={`上一轮（第 ${trick.trickNo} 墩）`} onClose={onClose} wide>
      <div className="last-trick-table" aria-label="按牌桌座位回看上一轮">
        {Object.entries(tableSeats(game.you.seat)).map(([position, seat]) => {
          const row = rows.find(play => play.seat === seat);
          const player = playerAt(seat);
          const order = rows.findIndex(play => play.seat === seat) + 1;
          return (
            <section
              key={seat}
              data-position={position}
              data-seat={seat}
              aria-label={`${POSITION_NAMES[position]} ${player?.nickname ?? ''}的出牌`}
              style={{ gridArea: position }}
              className={`last-trick-seat rounded-xl border ${
                row?.isWinner
                  ? 'border-amber-300/60 bg-amber-400/10'
                  : 'border-white/10 bg-black/20'
              }`}
            >
              <div className="last-trick-player mb-1 flex min-w-0 items-center justify-center gap-1 text-xs font-black">
                <span className="shrink-0 text-white/45">{POSITION_NAMES[position]}</span>
                <span className="truncate text-white/90" title={player?.nickname}>
                  {PLAYER_EMOJI[player?.id]} {player?.nickname ?? '—'}
                </span>
              </div>
              <div className="last-trick-meta mb-2 flex flex-wrap justify-center gap-x-2 text-[10px] font-bold text-white/50">
                {order > 0 && <span>第 {order} 手{row?.isLead ? ' · 领牌' : ''}</span>}
                {row?.isWinner && <span className="text-amber-300">🏆 赢家</span>}
              </div>
              <div className="last-trick-cards">
                {(row?.cards ?? []).map(card => (
                  <PlayingCard key={card.id} suit={card.suit} rank={card.rank} size="sm" />
                ))}
              </div>
            </section>
          );
        })}
        <div className="last-trick-score text-center" style={{ gridArea: 'score' }}>
          <div className="text-[10px] font-bold text-white/45">本墩</div>
          <div className="text-xl font-black text-amber-300">{trick.points ?? 0}</div>
          <div className="text-[10px] font-bold text-white/45">分</div>
        </div>
      </div>
      <div className="mt-3 text-center text-xs font-bold text-white/60">
        🏆 {PLAYER_EMOJI[winner?.id]} {winner?.nickname ?? '—'} 赢得这一墩
      </div>
    </Modal>
  );
}
