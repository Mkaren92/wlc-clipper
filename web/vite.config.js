import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const apiPort = Number(process.env.CLIPPER_PORT ?? 4517);

// Used only while developing the pages (npm run dev:web). The API server
// refuses requests that come from another address, so the browser's Origin
// header is dropped on the way through.
const toApi = {
  target: `http://127.0.0.1:${apiPort}`,
  changeOrigin: true,
  configure: (proxy) => proxy.on('proxyReq', (request) => request.removeHeader('origin')),
};

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  // The pages share code and the font with the rest of the project (../src, ../assets).
  server: { host: '127.0.0.1', port: 4518, proxy: { '/api': toApi, '/media': toApi }, fs: { allow: ['..'] } },
});
