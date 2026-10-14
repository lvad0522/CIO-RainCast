import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_BASE?.trim()
  const staticMode = env.VITE_STATIC_MODE === '1'

  // 双站点构建不能靠 App.jsx 的相对地址回退：产物一旦放错站点会静默连到
  // 错误后端。开发服务器仍允许走本地 proxy。
  // 例外：静态演示站（VITE_STATIC_MODE=1）没有后端，/api/* 全部由
  // src/staticMode.js 的 fetch 垫片读 public/demo-data/ 作答，因此不要求
  // VITE_API_BASE（也应显式不设，避免产物里留下真实后端地址）。
  if (command === 'build' && !apiBase && !staticMode) {
    throw new Error(
      'vite build 必须显式设置 VITE_API_BASE，例如 '
      + 'VITE_API_BASE=http://127.0.0.1:8002 npm run build；'
      + '静态演示站请改用 VITE_STATIC_MODE=1 npm run build',
    )
  }
  if (command === 'build' && staticMode && apiBase) {
    throw new Error('VITE_STATIC_MODE=1 与 VITE_API_BASE 互斥：静态站不应指向任何后端。')
  }

  return {
    // 相对 base：GitHub Pages 项目页部署在 /CIO-RainCast/ 子路径下，
    // 绝对 /assets 会 404。dev 下 Vite 会把它归一化成 '/'。
    base: './',
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
  }
})
