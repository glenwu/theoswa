// 逆时针方向 —— 唯一真源。
// 座位 0/2 一队、1/3 一队；揭牌、出牌、庄家轮转一律逆时针：0 → 3 → 2 → 1 → 0。
// 项目内任何轮转逻辑必须引用本模块，禁止别处硬编码 +1/-1。

export const SEAT_COUNT = 4;

// 下家（逆时针下一位）
export function nextSeat(seat) {
  return (seat + 3) % SEAT_COUNT;
}

// 对家（同队另一人）
export function oppositeSeat(seat) {
  return (seat + 2) % SEAT_COUNT;
}

// 上家（逆时针上一位）
export function prevSeat(seat) {
  return (seat + 1) % SEAT_COUNT;
}

// 从 seat 开始的完整逆时针顺序（含自己），用于揭牌/出牌顺序
export function seatOrderFrom(seat) {
  const order = [];
  for (let i = 0; i < SEAT_COUNT; i++) order.push((seat + 3 * i) % SEAT_COUNT);
  return order;
}
