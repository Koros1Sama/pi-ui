// src/main/index.ts
import { app, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { AuthService } from './auth-service'
import { ModelService } from './model-service'
import { SettingsService } from './settings-service'
import { PreferencesService } from './preferences-service'
import { SessionService } from './session-service'
import { IpcBridge } from './ipc-bridge'
import { SessionStore } from './session-store'

// ── Service singletons ──────────────────────────────────────────────────────
// Created once at module scope: rebuilt windows (macOS activate) reuse the
// same session/model stacks so old pi subprocesses are never orphaned, and
// app quit tears everything down deterministically instead of relying on
// stdin-EOF propagation to the children.
const auth = new AuthService()
const settings = new SettingsService()
const prefs = new PreferencesService(app.getPath('userData'))
const sessions = new SessionService()
const models = new ModelService(sessions)

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f0f0f',
    icon:
      process.platform === 'darwin'
        ? join(__dirname, '../../build/icon.icns')
        : join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const store = new SessionStore()
  const bridge = new IpcBridge(win, auth, models, settings, prefs, sessions, store)
  bridge.register()

  // Boot the shared model-listing hub early (off the critical path — it
  // loads user extensions and can take ~20s on a rich setup).
  models.prewarm()

  // Auto-updater — skip in dev and E2E
  let updater: import('./update-service').UpdateService | null = null
  if (!is.dev && !process.env['PI_E2E']) {
    const { UpdateService } = await import('./update-service')
    updater = new UpdateService(win, (event, payload) => bridge.sendToRenderer(event, payload))
    updater.init()
  }
  bridge.setUpdater(updater)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('ready-to-show', () => {
    if (!process.env['PI_E2E']) {
      win.show()
      // Check for updates 3 s after window is shown (non-blocking)
      if (updater) setTimeout(() => updater!.checkForUpdates(), 3000)
    }
  })
}

app.whenReady().then(() => {
  // Set Dock icon (macOS only) — needed when running unpackaged
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.icns'))
    app.dock.setIcon(icon)
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  sessions.disposeAll()
  models.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
