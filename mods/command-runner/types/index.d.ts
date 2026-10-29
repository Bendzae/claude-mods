/** A shell command started in the Commands pane, with the last lines it wrote. */
export type CommandRun = {
  id: string
  command: string
  cwd?: string
  status: 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped'
  /** Its process group, known once the wrapper has written it. */
  pid?: number
  startedAt: number
  endedAt?: number
  exitCode?: number
  signal?: string
  lines: string[]
  /** How many lines came before `lines[0]`: those past the kept ones. */
  firstLine?: number
  /** Output after the last newline: a progress line still being rewritten. */
  partial: string
}

declare module 'claude-code' {
  interface PluginState {
    'command-runner': {
      runs: CommandRun[]
      /** The run whose output shows; empty for the newest. */
      shown: string
      /** The line the output window ends before, counted from the run's first; -1 follows the newest. */
      scrollEnd: number
      now: number
    }
  }
}
