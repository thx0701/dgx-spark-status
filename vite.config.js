import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: '0.0.0.0',
    port: 9000,
    strictPort: true,
    fs: {
      allow: ['..']
    },
    hmr: {
      overlay: false // Disable error overlay that can cause reconnects
    }
  },
  optimizeDeps: {
    exclude: ['systeminformation'] // Exclude server-side dependencies
  }
});
