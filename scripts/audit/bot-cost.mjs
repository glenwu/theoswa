// 电脑决策的开销 —— Glen：「这个程序也不能太吃资源，不然对我的服务器压力也大」。
// 量两件事：跑一局要多久，以及几个已知的重活各被调用了多少次。
import { performance } from 'node:perf_hooks';
import { simulateRound } from '../../server/simulate-bots.js';

const N = Number(process.env.N ?? 20);
const t0 = performance.now();
let tricks = 0;
for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  tricks += (state?.round?.trickHistory ?? []).filter(t => !t.virtual).length;
}
const ms = performance.now() - t0;
console.log(`${N} 局 / ${tricks} 墩：${ms.toFixed(0)} ms，平均每局 ${(ms / N).toFixed(1)} ms、每墩 ${(ms / tricks).toFixed(2)} ms`);
