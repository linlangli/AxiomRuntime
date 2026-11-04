import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const consoleBuild = mode === 'console'
  return {
    plugins: [vue()],
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: '/',
    build: {
      outDir: fileURLToPath(new URL(consoleBuild ? '../dist/web/control' : './dist/portal', import.meta.url)),
      emptyOutDir: true,
      rollupOptions: { input: fileURLToPath(new URL(consoleBuild ? './console.html' : './index.html', import.meta.url)) }
    },
    server: { proxy: consoleBuild ? { '/api': 'http://127.0.0.1:8021' } : undefined }
  }
})
