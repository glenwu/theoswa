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
