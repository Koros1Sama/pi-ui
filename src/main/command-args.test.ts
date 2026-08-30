// @vitest-environment node
// src/main/command-args.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { discoverWorkflowIds, argSpecFor, withArgSpec } from './command-args'

describe('command-args', () => {
  const base = join(tmpdir(), `pi-ui-args-test-${Date.now()}`)
  const globalDir = join(base, 'global')
  const projectDir = join(base, 'project')

  beforeEach(() => {
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(globalDir, 'tdd.yml'), 'name: tdd')
    writeFileSync(join(globalDir, 'review.yaml'), 'name: review')
    writeFileSync(join(projectDir, 'pipeline.yml'), 'name: pipeline')
    writeFileSync(join(globalDir, 'readme.txt'), 'ignored')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  describe('discoverWorkflowIds', () => {
    it('collects yaml/yml ids from global and project dirs, sorted', () => {
      const ids = discoverWorkflowIds('/nowhere', [globalDir, projectDir])
      expect(ids).toEqual(['pipeline', 'review', 'tdd'])
    })

    it('returns empty when dirs are missing', () => {
      expect(discoverWorkflowIds('/nowhere', [join(base, 'missing')])).toEqual([])
    })
  })

  describe('argSpecFor', () => {
    it('gives workflow the discovered choices', () => {
      const spec = argSpecFor('workflow', '/nowhere', [globalDir, projectDir])
      expect(spec.choices).toEqual(['pipeline', 'review', 'tdd'])
      expect(spec.hint).toBe('workflow id')
    })

    it('marks skills and known builtins as free text with hints', () => {
      expect(argSpecFor('skill:brave', '/x').freeText).toBe(true)
      expect(argSpecFor('name', '/x').hint).toBe('title')
      expect(argSpecFor('compact', '/x').freeText).toBe(true)
    })

    it('returns an empty spec for unknown commands', () => {
      expect(argSpecFor('btw', '/x')).toEqual({})
    })
  })

  describe('withArgSpec', () => {
    it('attaches choices and hint, leaving others untouched', () => {
      const wf = withArgSpec({ name: 'workflow' }, '/nowhere', [globalDir])
      expect(wf.argChoices).toBeDefined()
      expect(wf.argHint).toBe('workflow id')

      const other = withArgSpec({ name: 'session-name' }, '/nowhere')
      expect(other.argChoices).toBeUndefined()
      expect(other.argHint).toBeUndefined()
    })
  })
})
