import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

/** The dev server needs localhost connections (HMR); production builds must not allow them. */
function productionCsp(): Plugin {
  return {
    name: 'production-csp',
    apply: 'build',
    transformIndexHtml: (html) => {
      const out = html.replace(/ ws:\/\/localhost:\* http:\/\/localhost:\*/, '')
      if (out.includes('localhost')) throw new Error('index.html CSP still allows localhost')
      return out
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Inference runs in an Electron utilityProcess; this is its entry point.
          worker: resolve(__dirname, 'src/main/llm/worker.ts'),
          // Speech-to-text (Whisper) runs in its own utilityProcess.
          speechWorker: resolve(__dirname, 'src/main/speech/worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: shared },
    plugins: [react(), productionCsp()],
    build: {
      minify: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
