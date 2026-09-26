import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 构建期产物会被 rust-embed 内嵌进二进制，因此：
//  1. 资源名必须带内容哈希（长期缓存 + ETag 由后端用内容哈希提供）
//  2. 不做 base 路径改写（面板总是从根路径提供服务）
//  3. 关闭 sourcemap 产出（单独归档用于排错，不进二进制）
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    // 体积预算：首屏 JS+CSS ≤150KB gzip（CI 门禁）
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('vue-router') || id.includes('pinia')) return 'vendor-vue'
            return 'vendor'
          }
        },
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]',
      },
    },
  },
  server: {
    // 开发期代理到 Rust 后端；生产由二进制内嵌提供，无 Node
    proxy: { '/api': { target: 'http://127.0.0.1:2083', changeOrigin: false } },
  },
})
