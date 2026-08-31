// @vitest-environment node
// src/main/settings-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsService } from './settings-service'

const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockMkdir = vi.fn()

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}))

vi.mock('os', () => ({ homedir: () => '/home/test' }))

describe('SettingsService', () => {
  let service: SettingsService

  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    service = new SettingsService()
  })

  describe('getDefaults', () => {
    it('returns parsed defaults from settings.json', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          defaultProvider: 'github-copilot',
          defaultModel: 'claude-sonnet-4.6',
          defaultThinkingLevel: 'low',
          defaultSystemPrompt: 'Be concise.',
        })
      )

      const defaults = await service.getDefaults()

      expect(defaults).toEqual({
        defaultProvider: 'github-copilot',
        defaultModel: 'claude-sonnet-4.6',
        defaultThinkingLevel: 'low',
        systemPrompt: 'Be concise.',
        defaultWorkingDirectory: null,
        favoriteModels: [],
        uiDirection: 'auto',
      })
    })

    it('returns safe defaults when settings.json does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))

      const defaults = await service.getDefaults()

      expect(defaults).toEqual({
        defaultProvider: null,
        defaultModel: null,
        defaultThinkingLevel: 'low',
        systemPrompt: '',
        defaultWorkingDirectory: null,
        favoriteModels: [],
        uiDirection: 'auto',
      })
    })

    it('reads persisted interface direction', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ piUIInterfaceDirection: 'rtl' }))

      const defaults = await service.getDefaults()

      expect(defaults.uiDirection).toBe('rtl')
    })
  })

  describe('setDefaults', () => {
    it('merges patch into existing settings and writes back', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ defaultProvider: 'github-copilot', someOtherKey: 'preserved' })
      )

      await service.setDefaults({ defaultModel: 'gpt-5', systemPrompt: 'Be brief.' })

      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
      expect(written.defaultModel).toBe('gpt-5')
      expect(written.defaultSystemPrompt).toBe('Be brief.')
      expect(written.defaultProvider).toBe('github-copilot') // preserved
      expect(written.someOtherKey).toBe('preserved') // preserved
    })

    it('persists favorite models under the piUI key and reads them back', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({}))
      await service.setDefaults({ favoriteModels: ['zai/glm-5.3', 'anthropic/claude-sonnet-4-5'] })
      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
      expect(written.piUIFavoriteModels).toEqual(['zai/glm-5.3', 'anthropic/claude-sonnet-4-5'])

      mockReadFile.mockResolvedValue(JSON.stringify({ piUIFavoriteModels: ['zai/glm-5.3'] }))
      const defaults = await service.getDefaults()
      expect(defaults.favoriteModels).toEqual(['zai/glm-5.3'])
    })
  })
})
