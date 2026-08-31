import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

interface PkgInfo {
  version: string
  name: string
  build?: { productName?: string }
}

function loadPkg(): PkgInfo {
  const raw = readFileSync('./package.json', 'utf-8')
  try {
    return JSON.parse(raw) as PkgInfo
  } catch (err) {
    // Rethrow with context — a corrupt package.json must fail the build loudly.
    throw new Error(`Invalid package.json: ${(err as Error).message}`)
  }
}

const pkg = loadPkg()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    css: { postcss: './postcss.config.cjs' },
    define: {
      'window.__APP_VERSION__': JSON.stringify(pkg.version),
      'window.__APP_NAME__': JSON.stringify(pkg.build?.productName ?? pkg.name),
    },
  },
})
