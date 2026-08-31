// src/renderer/src/components/modals/SettingsModal.tsx
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useStore } from '@/store'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { AppThinkingLevel, UiDirection } from '@shared/types'

const THINKING_LEVELS: AppThinkingLevel[] = ['off', 'low', 'high']
const DIRECTION_OPTIONS: { value: UiDirection; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Follows OS locale' },
  { value: 'ltr', label: 'LTR', hint: 'Left to right' },
  { value: 'rtl', label: 'RTL', hint: 'Right to left' },
]

export default function SettingsModal() {
  const ui = useStore((s) => s.ui)
  const config = useStore((s) => s.config)
  const closeSettings = useStore((s) => s.closeSettings)
  const setConfig = useStore((s) => s.setConfig)
  const setModels = useStore((s) => s.setModels)

  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [systemPrompt, setSystemPrompt] = useState(config.systemPrompt)
  const [defaultWorkingDirectory, setDefaultWorkingDirectory] = useState(
    config.defaultWorkingDirectory ?? ''
  )
  const [thinking, setThinking] = useState<AppThinkingLevel>(config.defaultThinkingLevel)
  const [defaultModel, setDefaultModel] = useState(
    config.defaultModel && config.defaultProvider
      ? `${config.defaultProvider}/${config.defaultModel}`
      : ''
  )
  const [favorites, setFavorites] = useState<string[]>(config.favoriteModels ?? [])
  const [direction, setDirection] = useState<UiDirection>(config.uiDirection ?? 'auto')

  // Mounted at app boot — local state captured the EMPTY config before
  // config:get() resolved (saving would silently wipe stored settings).
  // Reset during render when the modal opens (derived-reset pattern).
  const [prevOpen, setPrevOpen] = useState(ui.settingsOpen)
  if (ui.settingsOpen !== prevOpen) {
    setPrevOpen(ui.settingsOpen)
    if (ui.settingsOpen) {
      setSystemPrompt(config.systemPrompt)
      setDefaultWorkingDirectory(config.defaultWorkingDirectory ?? '')
      setThinking(config.defaultThinkingLevel)
      setDefaultModel(
        config.defaultModel && config.defaultProvider
          ? `${config.defaultProvider}/${config.defaultModel}`
          : ''
      )
      setFavorites(config.favoriteModels ?? [])
      setDirection(config.uiDirection ?? 'auto')
      setApiKeys({})
    }
  }

  async function toggleFavorite(key: string) {
    const next = favorites.includes(key) ? favorites.filter((f) => f !== key) : [...favorites, key]
    setFavorites(next)
    try {
      await window.pi.config.setDefaults({ favoriteModels: next })
      setConfig({ ...config, favoriteModels: next })
    } catch (err) {
      console.error('[favorites]', err)
    }
  }

  async function handleSaveApiKey(provider: string) {
    const key = apiKeys[provider]
    if (!key) return
    await window.pi.config.setApiKey(provider, key)
    const models = await window.pi.models.list()
    setModels(models)
    setConfig({
      ...config,
      providers: config.providers.map((p) =>
        p.name === provider ? { ...p, configured: true } : p
      ),
    })
  }

  async function handleSaveDefaults() {
    const [p, ...rest] = defaultModel.split('/')
    const m = rest.join('/')
    await window.pi.config.setDefaults({
      defaultThinkingLevel: thinking,
      systemPrompt,
      defaultModel: m || null,
      defaultProvider: p || null,
      defaultWorkingDirectory: defaultWorkingDirectory || null,
      uiDirection: direction,
    })
    setConfig({
      ...config,
      defaultThinkingLevel: thinking,
      systemPrompt,
      defaultModel: m || null,
      defaultProvider: p || null,
      defaultWorkingDirectory: defaultWorkingDirectory || null,
      uiDirection: direction,
    })
    closeSettings()
  }

  const apiKeyProviders = config.providers.filter((p) => p.authType === 'apikey')
  const oauthProviders = config.providers.filter((p) => p.authType === 'oauth')

  return (
    <Dialog open={ui.settingsOpen} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent
        data-testid="settings-modal"
        aria-describedby={undefined}
        className="max-h-[80vh] overflow-y-auto border-zinc-800 bg-[#161616] text-zinc-200 sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Settings</DialogTitle>
        </DialogHeader>

        {/* Close button: provided by DialogContent itself (no second ✕). */}

        {oauthProviders.length > 0 && (
          <div className="border-t border-zinc-900 pt-4">
            <p className="mb-3 text-[10px] uppercase tracking-widest text-zinc-500">
              Connected Accounts
            </p>
            {oauthProviders.map((p) => (
              <div key={p.name} className="mb-2 flex items-center justify-between">
                <span className="text-xs text-zinc-400">{p.name}</span>
                {p.configured ? (
                  <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-400">
                    ● connected
                  </span>
                ) : (
                  <span className="rounded-full border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">
                    Run <code className="font-mono">pi /login</code>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-zinc-900 pt-4">
          <p className="mb-3 text-[10px] uppercase tracking-widest text-zinc-500">API Keys</p>
          {apiKeyProviders.map((p) => (
            <div key={p.name} className="mb-3 flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-zinc-400">{p.name}</span>
              <Input
                data-testid={`api-key-input-${p.name.toLowerCase()}`}
                type="password"
                placeholder={
                  p.name === 'anthropic' ? 'sk-ant-…' : p.name === 'openai' ? 'sk-…' : 'API key'
                }
                value={apiKeys[p.name] ?? ''}
                onChange={(e) => setApiKeys((prev) => ({ ...prev, [p.name]: e.target.value }))}
                className={cn(
                  'flex-1 border-zinc-800 bg-zinc-900 font-mono text-xs',
                  p.configured && 'border-emerald-900 text-emerald-400'
                )}
              />
              <Button
                data-testid={`save-api-key-btn-${p.name.toLowerCase()}`}
                aria-label={`Save ${p.name}`}
                size="sm"
                onClick={() => handleSaveApiKey(p.name)}
                disabled={!apiKeys[p.name]}
                className="border border-zinc-800 bg-zinc-900 text-xs text-zinc-400 hover:text-zinc-200"
              >
                Save
              </Button>
            </div>
          ))}
          {apiKeyProviders.length === 0 && (
            <p className="text-xs text-zinc-700">No API key providers configured.</p>
          )}
        </div>

        <div className="border-t border-zinc-900 pt-4">
          <p className="mb-3 text-[10px] uppercase tracking-widest text-zinc-500">Defaults</p>
          <div className="mb-3">
            <label className="mb-1.5 block text-[10px] uppercase tracking-widest text-zinc-600">
              Default Model
            </label>
            <Select value={defaultModel} onValueChange={setDefaultModel}>
              <SelectTrigger
                data-testid="default-model-select"
                className="border-zinc-800 bg-zinc-900 text-xs text-zinc-300"
              >
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent
                position="popper"
                className="max-h-60 overflow-y-auto border-zinc-800 bg-zinc-900"
              >
                {config.models.map((m) => (
                  <SelectItem
                    key={`${m.provider}/${m.modelId}`}
                    value={`${m.provider}/${m.modelId}`}
                    className="text-xs text-zinc-300"
                  >
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mb-3">
            <label className="mb-1.5 block text-[10px] uppercase tracking-widest text-zinc-600">
              Thinking Level
            </label>
            <div className="flex overflow-hidden rounded border border-zinc-800">
              {THINKING_LEVELS.map((level) => (
                <button
                  key={level}
                  onClick={() => setThinking(level)}
                  className={cn(
                    'flex-1 py-1.5 text-xs capitalize',
                    thinking === level
                      ? 'bg-emerald-950 text-emerald-400'
                      : 'text-zinc-500 hover:text-zinc-300'
                  )}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-3">
            <label className="mb-1.5 block text-[10px] uppercase tracking-widest text-zinc-600">
              Favorite Models — Ctrl+P cycles these
            </label>
            <p className="mb-1.5 text-[10px] text-zinc-600">
              Star the models you switch between. Empty = cycles all models.
            </p>
            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-zinc-900 p-1">
              {config.models.map((m) => {
                const key = `${m.provider}/${m.modelId}`
                const active = favorites.includes(key)
                return (
                  <button
                    key={key}
                    data-testid={`favorite-${key}`}
                    onClick={() => void toggleFavorite(key)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-start text-xs transition-colors hover:bg-zinc-800"
                  >
                    <span className={active ? 'text-amber-400' : 'text-zinc-600'}>
                      {active ? '★' : '☆'}
                    </span>
                    <span className="truncate text-zinc-300">{m.displayName}</span>
                    <span className="ms-auto shrink-0 text-[10px] text-zinc-600">{m.provider}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="mb-3">
            <label className="mb-1.5 block text-[10px] uppercase tracking-widest text-zinc-600">
              Interface Direction
            </label>
            <div className="flex overflow-hidden rounded border border-zinc-800">
              {DIRECTION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  data-testid={`direction-${opt.value}`}
                  title={opt.hint}
                  onClick={() => setDirection(opt.value)}
                  className={cn(
                    'flex-1 py-1.5 text-xs',
                    direction === opt.value
                      ? 'bg-emerald-950 text-emerald-400'
                      : 'text-zinc-500 hover:text-zinc-300'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
              Auto follows your system language (Arabic/Hebrew/Farsi → RTL).
            </p>
          </div>
          <div className="mb-3">
            <label className="mb-1.5 block text-[10px] uppercase tracking-widest text-zinc-600">
              Default Working Directory
            </label>
            <div className="flex gap-2">
              <Input
                value={defaultWorkingDirectory}
                onChange={(e) => setDefaultWorkingDirectory(e.target.value)}
                placeholder="~/code/my-project"
                className="flex-1 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-300"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const dir = await window.pi.dialog.openDirectory()
                  if (dir) setDefaultWorkingDirectory(dir)
                }}
                className="shrink-0 border border-zinc-800 text-zinc-500 hover:text-zinc-300"
              >
                Browse
              </Button>
            </div>
          </div>
        </div>

        <div className="border-t border-zinc-900 pt-4">
          <p className="mb-3 text-[10px] uppercase tracking-widest text-zinc-500">System Prompt</p>
          <Textarea
            data-testid="system-prompt-input"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={4}
            placeholder="Global default system prompt for all sessions…"
            className="border-zinc-800 bg-zinc-900 text-xs text-zinc-300 placeholder-zinc-700"
          />
          <div className="mt-3 flex justify-end">
            <Button
              onClick={handleSaveDefaults}
              className="bg-emerald-950 text-xs text-emerald-400 hover:bg-emerald-900"
            >
              Save defaults
            </Button>
          </div>
        </div>

        <UpdateSection />
        <AboutSection />
      </DialogContent>
    </Dialog>
  )
}

function AboutSection() {
  const appName = window.__APP_NAME__ ?? 'Koros Pi UI'
  const appVersion = window.__APP_VERSION__ ?? 'dev'

  return (
    <div className="border-t border-zinc-900 pt-4">
      <p className="mb-3 text-[10px] uppercase tracking-widest text-zinc-500">About</p>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-zinc-300">{appName}</span>
        <span className="text-xs text-zinc-600">v{appVersion}</span>
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
        MIT License — by Koros Sama. Based on pi-ui by Marc Baqué.
      </p>
    </div>
  )
}

function UpdateSection() {
  const status = useStore((s) => s.ui.updateStatus)
  const version = useStore((s) => s.ui.updateVersion)
  const progress = useStore((s) => s.ui.updateProgress)
  const error = useStore((s) => s.ui.updateError)
  const appVersion = window.__APP_VERSION__ ?? 'dev'

  function statusLabel() {
    switch (status) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return `Downloading update${version ? ` v${version}` : ''}…`
      case 'downloading':
        return `Downloading${progress != null ? ` ${progress}%` : ''}…`
      case 'up-to-date':
        return `You’re up to date (v${version ?? appVersion})`
      case 'ready':
        return `v${version} ready — restart to install`
      case 'error':
        return `Update check failed${error ? `: ${error}` : ''}`
      default:
        return null
    }
  }

  const label = statusLabel()

  return (
    <div className="border-t border-zinc-900 pt-4">
      <p className="mb-3 text-[10px] uppercase tracking-widest text-zinc-500">App Updates</p>
      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-600">v{appVersion}</span>
        {status === 'ready' ? (
          <Button
            data-testid="update-install-settings-btn"
            size="sm"
            onClick={() => window.pi.update.install()}
            className="border border-[var(--pi-accent)] bg-transparent text-xs text-[var(--pi-accent)] hover:bg-zinc-800"
          >
            Restart &amp; update
          </Button>
        ) : (
          <Button
            data-testid="check-updates-btn"
            size="sm"
            disabled={status === 'checking' || status === 'available' || status === 'downloading'}
            onClick={() => window.pi.update.check()}
            className="border border-zinc-800 bg-transparent text-xs text-zinc-500 hover:text-zinc-300"
          >
            Check for updates
          </Button>
        )}
        {label && (
          <span
            className="text-xs"
            style={{
              color:
                status === 'error'
                  ? 'var(--pi-error)'
                  : status === 'ready'
                    ? 'var(--pi-success)'
                    : 'var(--pi-dim)',
            }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  )
}
