// 可复现的伪随机数生成器（mulberry32）。
// 服务端始终使用种子随机源（默认随机生成并打印种子），
// 用 SEED=<数字> 环境变量可复现同一副牌局。
// rng.state() 返回当前内部状态，用于持久化时续流（重启后不发重复的牌）。

export function mulberry32(seed) {
  let a = seed >>> 0;
  const fn = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.state = () => a;
  return fn;
}
