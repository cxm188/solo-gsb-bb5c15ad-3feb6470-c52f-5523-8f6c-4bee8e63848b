import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发服务器监听 0.0.0.0:5173，方便容器外访问
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
})
