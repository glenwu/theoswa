import { useEffect, useState } from 'react';

// 轻量“当前时间”轮询 hook：仅在 active 时每 intervalMs 刷新一次（用于倒计时显示）
export function useNow(active, intervalMs = 200) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

// 距 deadline 的剩余秒数（不小于 0）；deadline 为空返回 null
export function secondsLeft(deadline, now) {
  return deadline == null ? null : Math.max(0, (deadline - now) / 1000);
}

// 暂停时把「现在」冻结在暂停发生的那一刻。
//
// 服务端暂停后既不排计时器，也不推进任何截止时刻（恢复时由 pause.js 的
// shiftDeadlines 整体后移「暂停了多久」）。但客户端的 now 是真实时间，
// 不冻结的话界面上的倒计时会照跌 —— 暂停十分钟回来一看全是 0:00，
// 一恢复却又跳回原来的秒数，看着像坏了。
//
// ⚠️ 暂停弹窗自己的「已暂停 X 秒」不能用这个，它就是要跟着真实时间走。
export function displayNow(game, now) {
  return game?.paused ? game.paused.at : now;
}
