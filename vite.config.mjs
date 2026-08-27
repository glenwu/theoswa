import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const configDir = path.dirname(fileURLToPath(import.meta.url));

// 前端开发服务器（5173）；/ws 与 /api 代理到后端（8787）
// root/outDir 使用基于本文件目录的绝对路径，与启动时的 cwd 无关
//
// 两个端口都可以用环境变量顶掉，这样能起一份【和正在打的那局完全隔离】的预览：
//   API_PORT=8899 UI_PORT=5174 npm run client
// 配一个 PORT=8899 SAVE_FILE=... 的后端，就能改 UI 而不碰线上那一局。
const API_PORT = process.env.API_PORT ?? '8787';
const UI_PORT = Number(process.env.UI_PORT ?? 5173);

export default defineConfig({
  root: path.join(configDir, 'client'),
  plugins: [react(), tailwindcss()],
  server: {
    port: UI_PORT,
    host: true,
    proxy: {
      '/ws': { target: `ws://localhost:${API_PORT}`, ws: true },
      '/api': { target: `http://localhost:${API_PORT}` },
    },
  },
  build: {
    outDir: path.join(configDir, 'client', 'dist'),
    emptyOutDir: true,
  },
});
