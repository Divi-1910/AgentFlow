import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          changeOrigin: true,
          target: env.VITE_DEV_API_TARGET || 'http://localhost:9090',
        },
      },
    },
    test: {
      css: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.js',
    },
  }
})
