  import { defineConfig } from 'vite';
  import react from '@vitejs/plugin-react-swc';
  import tailwindcss from '@tailwindcss/vite';
  import path from 'path';
  import { execSync } from 'child_process';

  // Stable build id: git SHA or ISO timestamp fallback
  const buildId = (() => {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      return new Date().toISOString();
    }
  })();

  export default defineConfig({
    plugins: [
      tailwindcss(),
      react(),
      // Emit version.json into the build output so the running app can
      // compare its embedded build id against the deployed one.
      {
        name: 'version-json',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({ buildId }),
          });
        },
      },
    ],
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
    resolve: {
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      target: 'esnext',
      outDir: 'build',
    },
    server: {
      port: 3000,
      open: true,
    },
  });
