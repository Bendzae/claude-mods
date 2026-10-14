/**
 * One queued idea: what the person typed; whether it was sent to the session
 * on its own (it waits for the session to be free); whether the session has
 * started on it.
 */
export type Idea = { id: string; text: string; isSent?: boolean; isStarted: boolean }

declare module 'claude-code' {
  interface PluginState {
    'idea-queue': { ideas: Idea[] }
  }
}
