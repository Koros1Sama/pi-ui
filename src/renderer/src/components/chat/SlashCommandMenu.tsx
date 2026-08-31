// src/renderer/src/components/chat/SlashCommandMenu.tsx
import { useEffect, useRef } from 'react'
import type { SlashCommand } from '@shared/types'

interface Props {
  commands: SlashCommand[]
  activeIndex: number
  onSelect(command: SlashCommand): void
  onDismiss(): void
  /** Arguments already typed after the command (e.g. "foo bar" for "/cmd foo bar") */
  args?: string
  /** The command whose arguments are being typed (token match), if resolved */
  activeCommand?: SlashCommand
  /** Complete an argument choice for the active command and send it */
  onSelectArg?(command: SlashCommand, choice: string): void
}

const SOURCE_COLORS: Record<SlashCommand['source'], string> = {
  builtin: 'text-zinc-500',
  skill: 'text-emerald-600',
  prompt: 'text-blue-500',
  extension: 'text-purple-500',
}

export default function SlashCommandMenu({
  commands,
  activeIndex,
  onSelect,
  args,
  activeCommand,
  onSelectArg,
}: Props) {
  const itemRefs = useRef<Array<HTMLDivElement | null>>([])

  // Keep the keyboard-highlighted item inside the visible scroll region —
  // without this, arrowing past the first screenful looks like the commands
  // "disappeared" (125+ commands only show ~8 rows at a time).
  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, commands])

  if (commands.length === 0) {
    return (
      <div className="absolute bottom-full start-0 end-0 mb-1 rounded-lg border border-zinc-800 bg-zinc-900 py-2 shadow-lg">
        <p className="px-3 py-1 text-xs text-zinc-600">No commands match</p>
      </div>
    )
  }

  // Known argument choices for the resolved command (e.g. workflow ids),
  // filtered by what the user already typed.
  const argChoices =
    args && activeCommand?.argChoices?.length
      ? activeCommand.argChoices.filter((c) => c.toLowerCase().startsWith(args.toLowerCase()))
      : []

  return (
    <div
      role="listbox"
      data-testid="slash-command-menu"
      className="absolute bottom-full start-0 end-0 mb-1 max-h-56 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 py-1 shadow-lg"
    >
      {commands.map((cmd, i) => (
        <div
          key={`${cmd.source}:${cmd.name}`}
          ref={(el) => {
            itemRefs.current[i] = el
          }}
          role="option"
          aria-selected={i === activeIndex}
          title={args ? 'Arguments typed — Enter sends the text as-is' : undefined}
          onMouseDown={(e) => {
            // mouseDown prevents textarea blur before click fires
            e.preventDefault()
            if (!args) onSelect(cmd)
          }}
          className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs ${
            args ? 'opacity-50' : ''
          } ${i === activeIndex ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}
        >
          <span className="font-mono text-zinc-200">{cmd.name}</span>
          <span className={`shrink-0 text-[10px] ${SOURCE_COLORS[cmd.source]}`}>{cmd.source}</span>
          {args && i === activeIndex && (
            <span className="shrink-0 font-mono text-[10px] text-amber-500/80">{args}</span>
          )}
          {cmd.description && (
            <span className="ms-auto truncate text-zinc-600">{cmd.description}</span>
          )}
        </div>
      ))}

      {argChoices.length > 0 && (
        <div className="mt-1 border-t border-zinc-800/60 pt-1" data-testid="slash-arg-choices">
          {argChoices.map((choice) => (
            <div
              key={choice}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelectArg?.(activeCommand!, choice)
              }}
              className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-zinc-800/50"
            >
              <span className="text-[10px] text-amber-500/80">↳</span>
              <span className="font-mono text-zinc-300">{choice}</span>
              <span className="ms-auto text-[10px] text-zinc-600">click to run</span>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-zinc-800/60 px-3 py-1 text-[10px] text-zinc-600">
        {commands.length} commands
        {args
          ? argChoices.length > 0
            ? ` · ${argChoices.length} ${activeCommand?.argHint ?? 'choices'} · Enter sends as-is`
            : ` · Enter sends${activeCommand?.argHint ? ` (${activeCommand.argHint})` : ' with arguments'}`
          : ' · ↑↓ navigate · ↵ select'}
      </div>
    </div>
  )
}
