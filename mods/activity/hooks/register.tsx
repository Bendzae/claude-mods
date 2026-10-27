import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ActivityBoard, ActivityLoop, ActivityShell, ActivityTask } from '../types'

// What the session is doing, beside the transcript: the main loop and each
// subagent (nested under whoever spawned it), with its task list, its
// background shells and the last lines they wrote, what it is running now, and
// how long each has been going. Fed by the tool calls as they pass, the
// engine's agent list and the notices background tasks send when they end.

const PANE = 'activity'
const MAIN = 'main'
const TAIL_LINES = 4
/** Output files bigger than this aren't read for their tail. */
const TAIL_MAX_BYTES = 2 * 1024 * 1024

const board = atom({ plugin: 'activity', key: 'board' } as const, { loops: {} })
const now = atom({ plugin: 'activity', key: 'now' } as const, 0)
/** What the person folded away: `loop:<id>` and `shell:<id>`. */
const collapsed = atom({ plugin: 'activity', key: 'collapsed' } as const, [])

type Loose = Record<string, unknown>

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const oneLine = (text: string, max = 80) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function mainLoop(at: number): ActivityLoop {
  return { id: MAIN, label: 'Main session', status: 'idle', startedAt: at, tools: 0, tasks: [], shells: [] }
}

/** Changes one loop of the board (made if missing). */
async function changeLoop($: EngineInterface, id: string, fn: (loop: ActivityLoop) => ActivityLoop) {
  const at = await $.clock.now()
  await update($, board, b => {
    const loop =
      b.loops[id] ??
      (id === MAIN
        ? mainLoop(at)
        : { id, label: 'Subagent', status: 'running' as const, startedAt: at, tools: 0, tasks: [], shells: [] })
    return { ...b, loops: { ...b.loops, [id]: fn(loop) } }
  })
}

/** What a tool call is doing, in a few words. */
function describeCall(tool: string, input: Loose): string {
  const what =
    str(input.description) ??
    str(input.command) ??
    str(input.file_path) ??
    str(input.pattern) ??
    str(input.url) ??
    str(input.query) ??
    str(input.subject) ??
    str(input.prompt)
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
  return what === undefined ? name : `${name}: ${oneLine(what, 60)}`
}

/** A task list as TodoWrite writes it: whole, its items known by their text. */
function fromTodos(old: ActivityTask[], todos: unknown, at: number): ActivityTask[] {
  if (!Array.isArray(todos)) {
    return old
  }
  return todos.map((todo: Loose) => {
    const title = str(todo.content) ?? '…'
    const status = (str(todo.status) ?? 'pending') as ActivityTask['status']
    const before = old.find(task => task.id === title)
    return timed({ id: title, title: status === 'in_progress' ? (str(todo.activeForm) ?? title) : title, status }, before, at)
  })
}

/** Carries a task's times over, starting or stopping its clock as its status changes. */
function timed(task: ActivityTask, before: ActivityTask | undefined, at: number): ActivityTask {
  const startedAt = before?.startedAt ?? (task.status !== 'pending' ? at : undefined)
  const endedAt = task.status === 'completed' ? (before?.endedAt ?? at) : undefined
  return { ...task, startedAt: task.status === 'pending' ? undefined : startedAt, endedAt }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content.map((block: Loose) => (typeof block.text === 'string' ? block.text : '')).join('\n')
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** The last lines of each shell's output file: while it runs, and once more after it ends. */
async function readTails($: EngineInterface) {
  const { loops } = await read($, board)
  for (const loop of Object.values(loops)) {
    for (const shell of loop.shells) {
      if (shell.outputPath === undefined || shell.isTailFinal === true) {
        continue
      }
      const isFinal = shell.status !== 'running'
      try {
        const { size } = await $.fs.stat(shell.outputPath)
        if (size > TAIL_MAX_BYTES) {
          if (isFinal) {
            await changeLoop($, loop.id, l => ({
              ...l,
              shells: l.shells.map(s => (s.id === shell.id ? { ...s, isTailFinal: true } : s)),
            }))
          }
          continue
        }
        const text = await $.fs.read(shell.outputPath)
        const lines = text
          .replace(ANSI, '')
          .split(/\r?\n|\r/)
          .map(line => line.trimEnd())
          .filter(line => line !== '')
          .slice(-TAIL_LINES)
        if (isFinal || lines.join('\n') !== shell.tail.join('\n')) {
          await changeLoop($, loop.id, l => ({
            ...l,
            shells: l.shells.map(s => (s.id === shell.id ? { ...s, tail: lines, isTailFinal: isFinal } : s)),
          }))
        }
      } catch {
        // The file may not be there yet, or be gone already: once ended, stop trying.
        if (isFinal) {
          await changeLoop($, loop.id, l => ({
            ...l,
            shells: l.shells.map(s => (s.id === shell.id ? { ...s, isTailFinal: true } : s)),
          }))
        }
      }
    }
  }
}

/** The output file a background command's result names; the sentence's full stop isn't part of it. */
function outputPathIn(text: string): string | undefined {
  return /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(text)?.[1]
}

const ENDED = new Set(['completed', 'failed', 'killed'])

/** Marks the shells that background-task notices in `text` say have ended. */
async function fromNotices($: EngineInterface, text: string) {
  if (!text.includes('<task-notification>')) {
    return
  }
  const at = await $.clock.now()
  for (const notice of text.split('<task-notification>').slice(1)) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1]?.trim()
    const status = /<status>([^<]+)<\/status>/.exec(notice)?.[1]?.trim()
    if (id === undefined || status === undefined) {
      continue
    }
    const ended: ActivityShell['status'] = status === 'completed' ? 'completed' : status === 'killed' ? 'killed' : 'failed'
    await update($, board, b => {
      const loops: ActivityBoard['loops'] = {}
      for (const loop of Object.values(b.loops)) {
        loops[loop.id] = {
          ...loop,
          shells: loop.shells.map(s => (s.id === id && s.status === 'running' ? { ...s, status: ended, endedAt: at } : s)),
        }
      }
      return { ...b, loops }
    })
  }
}

/** Subagents from the engine's list: new ones added, statuses kept up. */
async function syncAgents($: EngineInterface) {
  const agents = await $.agent.list()
  const at = await $.clock.now()
  await update($, board, b => {
    const loops = { ...b.loops }
    for (const agent of agents) {
      const before = loops[agent.id]
      const status = agent.status as ActivityLoop['status']
      loops[agent.id] = {
        ...(before ?? { id: agent.id, startedAt: at, tools: 0, tasks: [], shells: [] }),
        label: oneLine(agent.description || agent.name || agent.type, 60),
        type: agent.type,
        status,
        parentId: agent.parentId ?? MAIN,
        endedAt: ENDED.has(status) ? (before?.endedAt ?? at) : undefined,
        current: ENDED.has(status) ? undefined : before?.current,
        currentStartedAt: ENDED.has(status) ? undefined : before?.currentStartedAt,
        currentCommand: ENDED.has(status) ? undefined : before?.currentCommand,
      }
    }
    return { ...b, loops }
  })
}

async function syncUsage($: EngineInterface) {
  const usage = await $.session.usage()
  await update($, board, b => ({ ...b, contextPercent: usage.context.percent }))
}

/** Clears what has finished: ended subagents, done shells and tasks of a list that is all done. */
function withoutFinished(b: ActivityBoard): ActivityBoard {
  const loops: Record<string, ActivityLoop> = {}
  for (const loop of Object.values(b.loops)) {
    if (loop.id !== MAIN && ENDED.has(loop.status)) {
      continue
    }
    const allDone = loop.tasks.length > 0 && loop.tasks.every(task => task.status === 'completed')
    loops[loop.id] = {
      ...loop,
      tasks: allDone ? [] : loop.tasks,
      shells: loop.shells.filter(shell => shell.status === 'running'),
    }
  }
  return { ...b, loops }
}

/** Done against everything: tasks, background shells and subagents. */
function progress(b: ActivityBoard): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const loop of Object.values(b.loops)) {
    for (const task of loop.tasks) {
      total += 1
      done += task.status === 'completed' ? 1 : 0
    }
    for (const shell of loop.shells) {
      total += 1
      done += shell.status === 'running' ? 0 : 1
    }
    if (loop.id !== MAIN) {
      total += 1
      done += ENDED.has(loop.status) ? 1 : 0
    }
  }
  return { done, total }
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m ${String(s % 60).padStart(2, '0')}s`
  }
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function bar(fraction: number, width: number): string {
  const filled = Math.round(fraction * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const SPIN = ['◐', '◓', '◑', '◒']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, board, b => (b.loops[MAIN] ? b : { ...b, loops: { ...b.loops, [MAIN]: mainLoop(at) } }))
    await update($, now, () => at)

    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      void (async () => {
        try {
          const t = await $.clock.now()
          await update($, now, () => t)
          await syncAgents($)
          if (ticks % 2 === 0) await readTails($)
          if (ticks % 5 === 0) await syncUsage($)
        } catch {
          // Nothing to show this second; the next one tries again.
        }
      })()
    })

    await $.command.register({ name: 'activity', description: 'Show what the session is doing: tasks, background shells, subagents' })
    void $.ui.open({ id: PANE, title: 'Activity' })

    return next(e)
  })

  on('command.run', { command: 'activity' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Activity' })

    return { text: 'Activity panel opened.' }
  })

  on('turn.start', async ($, e, next) => {
    try {
      await fromNotices($, e.text)
    } catch {
      // As below.
    }
    if (e.agentId === undefined) {
      try {
        const at = await $.clock.now()
        await changeLoop($, MAIN, loop => ({ ...loop, status: 'running', turnStartedAt: at }))
      } catch {
        // Tracking never holds a turn up.
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await changeLoop($, MAIN, loop => ({
          ...loop,
          status: 'idle',
          current: undefined,
          currentStartedAt: undefined,
          currentCommand: undefined,
        }))
      } catch {
        // As above.
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const loopId = e.agentId ?? MAIN
    const input = e as unknown as Loose
    const doing = describeCall(String(e.tool), input)
    const command = str(input.description) !== undefined ? str(input.command) : undefined
    let calledAt: number | undefined
    try {
      calledAt = await $.clock.now()
      const startedAt = calledAt
      await changeLoop($, loopId, loop => ({
        ...loop,
        tools: loop.tools + 1,
        current: doing,
        currentStartedAt: startedAt,
        currentCommand: command === undefined ? undefined : oneLine(command, 200),
      }))
    } catch {
      // Tracking never holds a tool up.
    }

    const ran = await next(e)

    try {
      const at = await $.clock.now()
      const result = (ran.result ?? {}) as Loose
      const tool = String(e.tool)
      await changeLoop($, loopId, loop => {
        let { tasks, shells } = loop
        if (tool === 'TodoWrite') {
          tasks = fromTodos(tasks, input.todos, at)
        } else if (tool === 'TaskCreate') {
          const task = (result.task ?? {}) as Loose
          const id = str(task.id)
          if (id !== undefined) {
            tasks = [...tasks, { id, title: str(task.subject) ?? str(input.subject) ?? '…', status: 'pending' }]
          }
        } else if (tool === 'TaskUpdate') {
          const id = str(input.taskId)
          const status = str(input.status)
          if (status === 'deleted') {
            tasks = tasks.filter(task => task.id !== id)
          } else {
            tasks = tasks.map(task =>
              task.id !== id
                ? task
                : timed(
                    {
                      ...task,
                      title:
                        status === 'in_progress'
                          ? (str(input.activeForm) ?? str(input.subject) ?? task.title)
                          : (str(input.subject) ?? task.title),
                      status: (status ?? task.status) as ActivityTask['status'],
                    },
                    task,
                    at,
                  ),
            )
          }
        } else if (tool === 'Bash' && str(result.backgroundTaskId) !== undefined) {
          const outputPath =
            str(result.backgroundOutputPath) ?? outputPathIn(ran.text ?? '')
          const shell: ActivityShell = {
            id: String(result.backgroundTaskId),
            title: str(input.description),
            command: oneLine(str(input.command) ?? 'shell', 200),
            status: 'running',
            // Sent to the background part way through (ctrl+b): timed from the call.
            startedAt: calledAt ?? at,
            outputPath,
            tail: [],
          }
          shells = [...shells.filter(s => s.id !== shell.id), shell]
        } else if (tool === 'TaskStop' || tool === 'KillShell') {
          const id = str(input.task_id) ?? str(input.shell_id)
          shells = shells.map(s => (s.id === id && s.status === 'running' ? { ...s, status: 'killed', endedAt: at } : s))
        }
        const isDone = loop.current === doing
        return {
          ...loop,
          tasks,
          shells,
          current: isDone ? undefined : loop.current,
          currentStartedAt: isDone ? undefined : loop.currentStartedAt,
          currentCommand: isDone ? undefined : loop.currentCommand,
        }
      })
    } catch {
      // As above.
    }

    return ran
  })

  // A background task's notice says it ended, and how: in the row it adds,
  // where that hook runs, and in the turn it starts.
  on('session.append', async ($, e, next) => {
    try {
      if (e.door !== 'tool-result' && e.message.type === 'user') {
        await fromNotices($, textOf((e.message as unknown as Loose).content))
      }
    } catch {
      // As above.
    }
    return next(e)
  })

  // At the end of each turn, the background work still in flight: a shell
  // that isn't among it has ended, however it did.
  on('classic.Stop', async ($, e, next) => {
    try {
      const inFlight = (e as unknown as Loose).background_tasks
      if (Array.isArray(inFlight)) {
        const ids = new Set(inFlight.map((task: Loose) => String(task.id)))
        const at = await $.clock.now()
        await update($, board, b => {
          const loops: ActivityBoard['loops'] = {}
          for (const loop of Object.values(b.loops)) {
            loops[loop.id] = {
              ...loop,
              shells: loop.shells.map(shell =>
                shell.status === 'running' && !ids.has(shell.id) ? { ...shell, status: 'completed', endedAt: at } : shell,
              ),
            }
          }
          return { ...b, loops }
        })
      }
    } catch {
      // As above.
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, board)
    const at = await read($, now)
    const spin = SPIN[Math.floor(at / 1000) % SPIN.length] ?? '◐'
    const width = Math.max(20, e.props.bodyColumns)
    const loops = Object.values(b.loops)
    const main = b.loops[MAIN]
    const { done, total } = progress(b)
    const fraction = total === 0 ? 0 : done / total
    const hasFinished = loops.some(
      loop =>
        (loop.id !== MAIN && ENDED.has(loop.status)) ||
        loop.shells.some(s => s.status !== 'running') ||
        (loop.tasks.length > 0 && loop.tasks.every(t => t.status === 'completed')),
    )

    const since = (start?: number, end?: number) => (start === undefined ? '' : duration((end ?? at) - start))

    const row = (key: string, glyph: string, color: string | undefined, label: string, right: string, dim = false) => (
      <Box key={key} flexDirection="row" gap={1}>
        <Text color={color}>{glyph}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor={dim} wrap="truncate-end">
            {label}
          </Text>
        </Box>
        <Text dimColor>{right}</Text>
      </Box>
    )

    const folded = new Set(await read($, collapsed))
    const toggle = (id: string) =>
      void update($, collapsed, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))

    /** A row that folds what's under it away when clicked. */
    const header = (id: string, glyph: string, color: string, label: string, right: string, dim = false, bold = false) => (
      <Box key={`head-${id}`} flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Button key={`toggle-${id}`} plain onPress={() => toggle(id)}>
            <Text dimColor>{folded.has(id) ? '▸' : '▾'} </Text>
            <Text color={color}>{glyph} </Text>
            <Text bold={bold} dimColor={dim}>
              {label}
            </Text>
          </Button>
        </Box>
        <Text dimColor>{right}</Text>
      </Box>
    )

    const loopGlyph = (loop: ActivityLoop): [string, string] => {
      if (loop.status === 'running' || loop.status === 'pending') return [spin, 'claude']
      if (loop.status === 'waiting') return ['◔', 'suggestion']
      if (loop.status === 'completed') return ['✓', 'success']
      if (loop.status === 'failed') return ['✗', 'error']
      if (loop.status === 'killed') return ['■', 'warning']
      return ['○', 'subtle']
    }

    const renderLoop = (loop: ActivityLoop, depth: number): RenderChildren => {
      const [glyph, color] = loopGlyph(loop)
      const children = loops.filter(other => other.id !== MAIN && (other.parentId ?? MAIN) === loop.id)
      const isMain = loop.id === MAIN
      const clock = isMain
        ? loop.status === 'running'
          ? `turn ${since(loop.turnStartedAt)}`
          : 'idle'
        : since(loop.startedAt, loop.endedAt)
      const label = isMain ? loop.label : `${loop.label}${loop.type ? ` · ${loop.type}` : ''}`
      return (
        <Box key={`loop-${loop.id}`} flexDirection="column" paddingLeft={depth === 0 ? 0 : 2}>
          {header(
            `loop:${loop.id}`,
            glyph,
            color,
            label,
            `${loop.tools > 0 ? `${loop.tools} tools · ` : ''}${clock}`,
            false,
            isMain,
          )}
          {!folded.has(`loop:${loop.id}`) && (
          <Box flexDirection="column" paddingLeft={2}>
            {loop.current !== undefined && (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text color="suggestion" italic wrap="truncate-end">
                      ↳ {loop.current}
                    </Text>
                  </Box>
                  <Text dimColor>{since(loop.currentStartedAt)}</Text>
                </Box>
                {loop.currentCommand !== undefined && (
                  <Box paddingLeft={2}>
                    <Text color="bashBorder" dimColor wrap="truncate-end">
                      $ {loop.currentCommand}
                    </Text>
                  </Box>
                )}
              </Box>
            )}
            {loop.tasks.map(task =>
              row(
                `task-${loop.id}-${task.id}`,
                task.status === 'completed' ? '✓' : task.status === 'in_progress' ? spin : '○',
                task.status === 'completed' ? 'success' : task.status === 'in_progress' ? 'claude' : 'subtle',
                task.title,
                since(task.startedAt, task.endedAt),
                task.status === 'completed',
              ),
            )}
            {loop.shells.map(shell => (
              <Box key={`shell-${loop.id}-${shell.id}`} flexDirection="column">
                {header(
                  `shell:${shell.id}`,
                  shell.status === 'running' ? spin : shell.status === 'completed' ? '✓' : shell.status === 'killed' ? '■' : '✗',
                  shell.status === 'running'
                    ? 'bashBorder'
                    : shell.status === 'completed'
                      ? 'success'
                      : shell.status === 'killed'
                        ? 'warning'
                        : 'error',
                  shell.title ?? `$ ${shell.command}`,
                  since(shell.startedAt, shell.endedAt),
                  shell.status !== 'running',
                )}
                {!folded.has(`shell:${shell.id}`) && shell.title !== undefined && (
                  <Box paddingLeft={2}>
                    <Text color="bashBorder" dimColor={shell.status !== 'running'} wrap="truncate-end">
                      $ {shell.command}
                    </Text>
                  </Box>
                )}
                {!folded.has(`shell:${shell.id}`) && shell.tail.length > 0 && (
                  <Box flexDirection="column" paddingLeft={2}>
                    {shell.tail.map((line, i) => (
                      <Text key={`tail-${shell.id}-${i}`} dimColor wrap="truncate-end">
                        │ {line}
                      </Text>
                    ))}
                  </Box>
                )}
              </Box>
            ))}
            {children.map(child => renderLoop(child, depth + 1))}
          </Box>
          )}
        </Box>
      )
    }

    const facts = [
      main?.status === 'running' ? `turn ${since(main.turnStartedAt)}` : undefined,
      b.contextPercent !== undefined ? `context ${Math.round(b.contextPercent)}%` : undefined,
    ].filter(fact => fact !== undefined)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color="claude">
              ◉ Activity
            </Text>
            <Text dimColor>{facts.join(' · ')}</Text>
          </Box>
          {total > 0 && (
            <Box flexDirection="row" gap={1}>
              <Text color="success">{bar(fraction, Math.max(10, Math.min(30, width - 16)))}</Text>
              <Text bold>{Math.round(fraction * 100)}%</Text>
              <Text dimColor>
                {done}/{total}
              </Text>
            </Box>
          )}
        </Box>
        {main !== undefined && renderLoop(main, 0)}
        {hasFinished && (
          <Button key="clear" plain label="clear finished" onPress={() => void update($, board, withoutFinished)} />
        )}
      </Box>
    )
  })
}
