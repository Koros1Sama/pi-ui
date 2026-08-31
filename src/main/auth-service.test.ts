// @vitest-environment node
// src/main/auth-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuthService } from './auth-service'

const mockGetAll = vi.fn()
const mockSet = vi.fn()

vi.mock('@mariozechner/pi-coding-agent', () => ({
  AuthStorage: {
    create: vi.fn(() => ({ getAll: mockGetAll, set: mockSet })),
  },
}))

describe('AuthService', () => {
  let service: AuthService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new AuthService()
  })

  describe('getProviderStatuses', () => {
    it('marks oauth provider as configured when entry exists with type oauth', async () => {
      mockGetAll.mockReturnValue({
        'github-copilot': { type: 'oauth', access: 'token' },
      })

      const statuses = await service.getProviderStatuses()
      const copilot = statuses.find((s) => s.name === 'github-copilot')

      expect(copilot).toEqual({ name: 'github-copilot', authType: 'oauth', configured: true })
    })

    it('marks oauth provider as not configured when absent', async () => {
      mockGetAll.mockReturnValue({})

      const statuses = await service.getProviderStatuses()
      const copilot = statuses.find((s) => s.name === 'github-copilot')

      expect(copilot).toEqual({ name: 'github-copilot', authType: 'oauth', configured: false })
    })

    it('marks api key provider as configured when entry exists with type api_key', async () => {
      mockGetAll.mockReturnValue({
        anthropic: { type: 'api_key', key: 'sk-ant-abc' },
      })

      const statuses = await service.getProviderStatuses()
      const anthropic = statuses.find((s) => s.name === 'anthropic')

      expect(anthropic).toEqual({ name: 'anthropic', authType: 'apikey', configured: true })
    })

    it('marks api key provider as not configured when absent', async () => {
      mockGetAll.mockReturnValue({})

      const statuses = await service.getProviderStatuses()
      const anthropic = statuses.find((s) => s.name === 'anthropic')

      expect(anthropic).toEqual({ name: 'anthropic', authType: 'apikey', configured: false })
    })

    it('lists zai and kimi-coding as api-key providers', async () => {
      mockGetAll.mockReturnValue({})

      const statuses = await service.getProviderStatuses()
      const names = statuses.filter((s) => s.authType === 'apikey').map((s) => s.name)

      expect(names).toContain('zai')
      expect(names).toContain('kimi-coding')
    })

    it('marks zai as configured when auth.json holds its key', async () => {
      mockGetAll.mockReturnValue({ zai: { type: 'api_key', key: 'zk' } })

      const statuses = await service.getProviderStatuses()
      const zai = statuses.find((s) => s.name === 'zai')

      expect(zai).toEqual({ name: 'zai', authType: 'apikey', configured: true })
    })

    it('discovers extra stored api_key credentials outside the built-in lists', async () => {
      mockGetAll.mockReturnValue({
        minimax: { type: 'api_key', key: 'mm' },
        'my-custom-provider': { type: 'api_key', key: 'x' },
      })

      const statuses = await service.getProviderStatuses()
      const minimax = statuses.find((s) => s.name === 'minimax')
      const custom = statuses.find((s) => s.name === 'my-custom-provider')

      expect(minimax).toEqual({ name: 'minimax', authType: 'apikey', configured: true })
      expect(custom).toEqual({ name: 'my-custom-provider', authType: 'apikey', configured: true })
    })

    it('does not duplicate oauth credentials as api-key extras', async () => {
      mockGetAll.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 't' } })

      const statuses = await service.getProviderStatuses()

      expect(statuses.filter((s) => s.name === 'github-copilot')).toHaveLength(1)
    })
  })

  describe('setApiKey', () => {
    it('calls AuthStorage.set with an api_key credential', async () => {
      await service.setApiKey('anthropic', 'sk-ant-xyz')

      expect(mockSet).toHaveBeenCalledWith('anthropic', { type: 'api_key', key: 'sk-ant-xyz' })
    })
  })
})
