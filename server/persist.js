import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeState } from './state.js';

// 最简单的持久化：整个 GameState 序列化到单个 JSON 文件。
// 12 小时内有效；服务端启动时自动恢复，进程重启不丢一晚上的战果。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SAVE_FILE = process.env.SAVE_FILE ?? path.join(__dirname, 'savegame.json');
export const SAVE_EXPIRY_MS = 12 * 3600 * 1000; // 12 小时

// 序列化：rng 是函数（JSON 自动丢弃），显式保存其内部状态用于续流
export function serializeState(state) {
  const snapshot = { ...state };
  snapshot.rng = undefined;
  snapshot.rngState = typeof state.rng?.state === 'function' ? state.rng.state() : null;
  return JSON.stringify({ savedAt: Date.now(), game: snapshot }, null, 2);
}

// 读取存档：不存在 / 损坏 / 过期 均返回 null
export function loadSavedGame(file = SAVE_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.savedAt !== 'number' || !data.game) return null;
    if (Date.now() - data.savedAt > SAVE_EXPIRY_MS) return null; // 过期
    return normalizeState(data.game); // 旧版本存档缺新字段 → 按默认补齐
  } catch {
    return null;
  }
}

export function saveGame(state, file = SAVE_FILE) {
  try {
    fs.writeFileSync(file, serializeState(state));
    return true;
  } catch (e) {
    console.error('[持久化] 写入失败：', e.message);
    return false;
  }
}

export function clearSave(file = SAVE_FILE) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 不存在则忽略 */
  }
}
