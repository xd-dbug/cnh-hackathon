import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Mocks are imported from ../contract/examples, which is outside web/.
  server: { port: 5173, fs: { allow: ['..'] } },
});
