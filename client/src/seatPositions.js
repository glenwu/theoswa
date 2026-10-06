import { nextSeat, oppositeSeat, prevSeat } from '../../server/rotation.js';

// 牌桌和回看窗口共用同一视角：自己在下，对家在上，上家在左，下家在右。
export function tableSeats(viewerSeat) {
  return {
    top: oppositeSeat(viewerSeat),
    left: prevSeat(viewerSeat),
    right: nextSeat(viewerSeat),
    self: viewerSeat,
  };
}
