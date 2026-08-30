// src/main/command-args.ts
//
// Argument specs for slash commands. pi's RPC protocol does not expose
// extension getArgumentCompletions, so pi-ui replicates the discovery for
// well-known commands:
//   - workflow: ids from the same directories the workflow extension reads
//     (~/.pi/workflows + <cwd>/.pi/workflows, YAML filenames)
//   - builtins: static hints
// Everything else falls back to free text (or no hint).
import { readdirSync } from 'fs'
import { basename, extname, join } from 'path'
import { homedir } from 'os'

export interface ArgSpec {
  /** Known choices offered as clickable completions after the command. */
  choices?: string[]
  /** Short label shown in the menu footer (e.g. "workflow id"). */
  hint?: string
  /** True when the argument is free-form text. */
  freeText?: boolean
}

export function workflowDirs(cwd: string): string[] {
  return [join(homedir(), '.pi', 'workflows'), join(cwd, '.pi', 'workflows')]
}

/** Workflow ids discovered the same way the workflow extension does it. */
export function discoverWorkflowIds(cwd: string, dirs?: string[]): string[] {
  const ids = new Set<string>()
  for (const dir of dirs ?? workflowDirs(cwd)) {
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isFile() && (f.name.endsWith('.yaml') || f.name.endsWith('.yml'))) {
          ids.add(basename(f.name, extname(f.name)))
        }
      }
    } catch {
      // directory missing — fine
    }
  }
  return [...ids].sort()
}

export function argSpecFor(commandName: string, cwd: string, dirs?: string[]): ArgSpec {
  if (commandName === 'workflow') {
    return { choices: discoverWorkflowIds(cwd, dirs), hint: 'workflow id' }
  }
  if (commandName.startsWith('skill:')) {
    return { freeText: true, hint: 'instructions (optional)' }
  }
  switch (commandName) {
    case 'name':
      return { freeText: true, hint: 'title' }
    case 'compact':
      return { freeText: true, hint: 'focus instructions (optional)' }
    case 'export':
      return { freeText: true, hint: 'output path (optional)' }
    default:
      return {}
  }
}

/** Merge an ArgSpec onto a SlashCommand (choices only when non-empty). */
export function withArgSpec<T extends { name: string }>(
  command: T,
  cwd: string,
  dirs?: string[]
): T & { argChoices?: string[]; argHint?: string } {
  const spec = argSpecFor(command.name, cwd, dirs)
  const enriched = { ...command } as T & { argChoices?: string[]; argHint?: string }
  if (spec.choices && spec.choices.length > 0) enriched.argChoices = spec.choices
  if (spec.hint) enriched.argHint = spec.hint
  return enriched
}
