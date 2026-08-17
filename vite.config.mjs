import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const configDir = path.dirname(fileURLToPath(import.meta.url));

// 前端开发服务器（5173）；/ws 与 /api 代理到后端（8787）
// root/outDir 使用基于本文件目录的绝对路径，与启动时的 cwd 无关
export default defineConfig({
  root: path.join(configDir, 'client'),
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
  build: {
    outDir: path.join(configDir, 'client', 'dist'),
    emptyOutDir: true,
  },
});
