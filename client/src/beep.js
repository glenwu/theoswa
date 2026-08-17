// 轻提示音（出牌倒计时最后 10 秒）。无音频环境/未交互时静默忽略。
let audioCtx = null;

export function beep() {
  try {
    audioCtx =
      audioCtx ??
      new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch {
    /* 忽略：浏览器未授权音频或环境不支持 */
  }
}
