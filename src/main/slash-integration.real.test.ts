// @vitest-environment node
// src/main/slash-integration.real.test.ts
// REAL-PI integration: skipped unless REAL_PI=1 (slow, spawns the actual CLI).
//   REAL_PI=1 pnpm vitest run slash-integration.real
import { describe, it, expect } from 'vitest'
import { SessionService } from './session-service'
import type { PiEventName, PiEventPayloads } from '@shared/types'

type Ev = { event: PiEventName; payload: PiEventPayloads[PiEventName] }

describe.skipIf(!process.env['REAL_PI'])(
  'real pi slash commands (SessionService → global CLI 0.84.x)',
  () => {
    it('executes /tree and an extension command end-to-end', async () => {
      const events: Ev[] = []
      const svc = new SessionService()
      const onEvent = <E extends PiEventName>(event: E, payload: PiEventPayloads[E]) => {
        events.push({ event, payload } as Ev)
      }

      const { sessionId } = await svc.createSession(
        { cwd: process.cwd(), provider: 'zai', model: 'glm-5.3', thinkingLevel: 'low' },
        onEvent
      )
      try {
        // Fresh-session thinking info: level + the levels THIS model supports
        // (the exact call the Toolbar makes when a session becomes ready).
        await waitFor(() => {
          if (events.some((e) => e.event === 'pi:session-ready')) return
          throw new Error('not ready yet')
        }, 120_000)
        const info = await svc.getThinkingInfo(sessionId)
        console.log('[real] thinking info:', JSON.stringify(info))
        expect(typeof info.level).toBe('string')
        expect(info.levels.length).toBeGreaterThan(1) // glm supports effort levels

        // /tree — pi-ui builtin intercepted locally: get_tree + text + picker
        await svc.send(sessionId, '/tree')
        const treePicker = await waitFor(
          () => events.find((e) => e.event === 'pi:tree-picker'),
          120_000
        )
        expect(treePicker).toBeDefined()

        // Extension command executes and produces SOME assistant output
        await svc.send(sessionId, '/ctx-stats')
        const tokens = await waitFor(() => {
          const t = events.find((e) => e.event === 'pi:token')
          if (t) return t
          throw new Error('no tokens yet')
        }, 180_000).catch(() => null)
        console.log(
          '[real] events seen:',
          [...new Set(events.map((e) => e.event))].join(', '),
          '| tokens?',
          tokens ? 'yes' : 'no'
        )
        expect(tokens).not.toBeNull()
      } finally {
        await svc.disposeAll()
      }
    }, 400_000)
  }
)

function waitFor<T>(probe: () => T, timeoutMs: number, intervalMs = 500): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      try {
        resolve(probe())
      } catch {
        if (Date.now() - started > timeoutMs) {
          reject(new Error('waitFor timeout'))
          return
        }
        setTimeout(tick, intervalMs)
      }
    }
    tick()
  })
}
