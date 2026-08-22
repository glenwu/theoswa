// 变异测试的共用 runner。
//
// ⚠️ 存在的理由：这些脚本会【就地改写源码】再跑测试。原来每个脚本只是
// 「写入 → 跑测试 → 写回」，一旦进程在中间被杀（超时、Ctrl-C），源码就
// 停在变异状态 —— 已经踩过一次：某次批量跑超时被 SIGKILL，
// maxOpponentTrumpEstimate 被留成变异版，下一轮 npm test 莫名其妙红了三条。
//
// 这里保证：无论正常结束、抛异常，还是收到 SIGINT/SIGTERM，都把所有
// 动过的文件还原。SIGKILL 仍然救不了（谁也救不了），但那是最后一道。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export function runMutants(mutants, { command = 'npm', args = ['test'] } = {}) {
  const originals = new Map();
  const snapshot = file => {
    if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
    return originals.get(file);
  };
  const restoreAll = () => {
    for (const [file, src] of originals) {
      try { fs.writeFileSync(file, src); } catch { /* 尽力而为 */ }
    }
  };

  const onSignal = sig => { restoreAll(); process.exit(sig === 'SIGINT' ? 130 : 143); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', err => { restoreAll(); throw err; });

  let killed = 0, alive = 0, skipped = 0;
  try {
    for (const [file, oldStr, newStr, desc] of mutants) {
      const src = snapshot(file);
      if (!src.includes(oldStr)) {
        skipped += 1;
        console.log(`⚠️ SKIP    ${desc}  ← 锚点失效，请更新到当前代码`);
        continue;
      }
      fs.writeFileSync(file, src.replace(oldStr, newStr));
      let died = false, note = '';
      try {
        execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
      } catch (e) {
        died = true;
        note = (String(e.stdout ?? '').split('\n').find(l => l.startsWith('not ok')) ?? '')
          .replace(/^not ok \d+ - /, '').slice(0, 44);
      }
      fs.writeFileSync(file, src);
      died ? (killed += 1) : (alive += 1);
      console.log(`${(died ? 'KILLED' : '⚠️ 存活').padEnd(9)} ${desc}${note ? `  ← ${note}` : ''}`);
    }
  } finally {
    restoreAll();
  }

  console.log(`\n被杀 ${killed} / 存活 ${alive} / 锚点失效 ${skipped}`);
  return { killed, alive, skipped };
}
