import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig({
  base: './',
  define: {
    '__filename': '"/"',
    '__dirname': '"/"',
  },
  resolve: {
    alias: {
      'serialport': path.resolve('./src/mock.js'),
      'bindings': path.resolve('./src/mock.js')
    }
  },
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      include: ['events', 'stream', 'util', 'buffer', 'process', 'timers', 'path', 'fs']
    }),
  ]
});