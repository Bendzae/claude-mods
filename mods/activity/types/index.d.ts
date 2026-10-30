/** One item of a task list (TodoWrite or TaskCreate/TaskUpdate). */
export type ActivityTask = {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed'
  startedAt?: number
  endedAt?: number
}

/** A shell command run in the background, with the last lines of its output. */
export type ActivityShell = {
  id: string
  /** What the model said it does, when it said, else what a small model made of the command. */
  title?: string
  /** A small model was asked for a title: it is not asked again. */
  isTitleAsked?: boolean
  command: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  startedAt: number
  endedAt?: number
  outputPath?: string
  tail: string[]
  /** Its output read once more after it ended. */
  isTailFinal?: boolean
}

/** A model loop: the main session or one of its subagents. */
export type ActivityLoop = {
  id: string
  label: string
  type?: string
  status: 'idle' | 'running' | 'waiting' | 'pending' | 'completed' | 'failed' | 'killed'
  parentId?: string
  startedAt: number
  endedAt?: number
  /** When the main loop's current turn started. */
  turnStartedAt?: number
  tools: number
  /** The tool call under way, in a few words. */
  current?: string
  /** When it started. */
  currentStartedAt?: number
  /** A shell command under way, when the words above are its description. */
  currentCommand?: string
  tasks: ActivityTask[]
  shells: ActivityShell[]
}

export type ActivityBoard = {
  loops: Record<string, ActivityLoop>
  contextPercent?: number
}

declare module 'claude-code' {
  interface PluginState {
    activity: { board: ActivityBoard; now: number; flipped: string[] }
  }
}
