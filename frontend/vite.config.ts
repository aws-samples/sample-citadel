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
      // @monaco-editor/loader's default config module hardcodes a
      // jsdelivr CDN URL as its initial `paths.vs` value. That default
      // is dead once monacoSetup.ts calls `loader.config({ monaco })`
      // with the locally bundled monaco instance, but the literal
      // string still ends up in the production bundle. Strip it at
      // transform time so no cdn.jsdelivr.net string reaches output.
      {
        name: 'strip-monaco-loader-cdn-default',
        transform(code, id) {
          if (id.includes('@monaco-editor/loader') && code.includes('cdn.jsdelivr.net')) {
            return code.replace(
              /https:\/\/cdn\.jsdelivr\.net\/npm\/monaco-editor@[^'"]*/g,
              ''
            );
          }
          return null;
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
