import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CommandRun } from '../types'

// Shell commands run beside the transcript: /run-command hands the person's
// description to the model, which starts the command with the `run` tool; its
// output streams into the Commands pane, which can stop it.

const PANE = 'command-runner'
const TITLE = 'Commands'
const RUN_TOOL = 'mcp__command-runner__run'
const KEEP_LINES = 1000
const KEEP_RUNS = 30

const runs = atom({ plugin: 'command-runner', key: 'runs' } as const, [])
const shown = atom({ plugin: 'command-runner', key: 'shown' } as const, '')
const now = atom({ plugin: 'command-runner', key: 'now' } as const, 0)
const scrollEnd = atom({ plugin: 'command-runner', key: 'scrollEnd' } as const, -1)
let runCount = 0
/** Output rows the pane drew last, which a scroll keeps filled. */
let lastRoom = 10

// The command runs in a process group of its own, so a stop reaches whatever
// it started too; the wrapper writes the group's id to stderr before the exec.
// `script` gives the command a terminal of its own, so it writes its colours;
// that terminal's processes are a group of their own again.
const PID_MARK = /__command_runner_pid__=(\d+)\n/
const WRAPPER = 'setpgrp(0, 0); print STDERR "__command_runner_pid__=$$\\n"; exec @ARGV or die "exec: $!\\n"'
const NO_PAGER = { PAGER: 'cat', GIT_PAGER: 'cat' }

// eslint-disable-next-line no-control-regex
const ESCAPE = /\u001b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g
// eslint-disable-next-line no-control-regex
const SGR = /^\u001b\[[0-9;:]*m$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0007\u000b-\u001a\u001c-\u001f\u007f]/g

/** A line as the pane can draw it: colour codes kept, other escapes dropped, only what the last carriage return left. */
function clean(line: string): string {
  let visible = line.replace(ESCAPE, code => (SGR.test(code) ? code : '')).replace(/\r+$/, '')
  visible = visible.slice(visible.lastIndexOf('\r') + 1)
  while (/[^\b]\u0008/.test(visible)) {
    visible = visible.replace(/[^\b]\u0008/, '')
  }
  return visible.replace(/\t/g, '    ').replace(CONTROL, '')
}

type Style = {
  color?: string
  backgroundColor?: string
  bold?: boolean
  dimColor?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
  strikethrough?: boolean
}

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

const hex = (...rgb: number[]) => `#${rgb.map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`

/** One of the 256 palette colours: the 16 by name, so they follow the person's terminal theme. */
function paletteColor(n: number): string {
  if (n < 8) return NAMES[n] ?? 'white'
  if (n < 16) return `${NAMES[n - 8]}Bright`
  if (n < 232) {
    const level = (c: number) => (c === 0 ? 0 : 55 + c * 40)
    const i = n - 16
    return hex(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6))
  }
  const gray = 8 + (n - 232) * 10
  return hex(gray, gray, gray)
}

/** The style after one SGR sequence's parameters. */
function applySgr(style: Style, params: number[]): Style {
  let next = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0
    if (p === 0) next = {}
    else if (p === 1) next.bold = true
    else if (p === 2) next.dimColor = true
    else if (p === 3) next.italic = true
    else if (p === 4) next.underline = true
    else if (p === 7) next.inverse = true
    else if (p === 9) next.strikethrough = true
    else if (p === 22) next = { ...next, bold: undefined, dimColor: undefined }
    else if (p === 23) next.italic = undefined
    else if (p === 24) next.underline = undefined
    else if (p === 27) next.inverse = undefined
    else if (p === 29) next.strikethrough = undefined
    else if (p >= 30 && p <= 37) next.color = NAMES[p - 30]
    else if (p >= 90 && p <= 97) next.color = `${NAMES[p - 90]}Bright`
    else if (p === 39) next.color = undefined
    else if (p >= 40 && p <= 47) next.backgroundColor = NAMES[p - 40]
    else if (p >= 100 && p <= 107) next.backgroundColor = `${NAMES[p - 100]}Bright`
    else if (p === 49) next.backgroundColor = undefined
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'color' : 'backgroundColor'
      if (params[i + 1] === 5) {
        next[key] = paletteColor(params[i + 2] ?? 0)
        i += 2
      } else if (params[i + 1] === 2) {
        next[key] = hex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0)
        i += 4
      }
    }
  }
  return next
}

/** A line cut into runs of one style each. */
function styled(line: string): { text: string; style: Style }[] {
  const parts: { text: string; style: Style }[] = []
  let style: Style = {}
  let at = 0
  // eslint-disable-next-line no-control-regex
  for (const code of line.matchAll(/\u001b\[([0-9;:]*)m/g)) {
    if (code.index > at) parts.push({ text: line.slice(at, code.index), style })
    style = applySgr(style, (code[1] ?? '').split(/[;:]/).map(p => (p === '' ? 0 : Number(p))))
    at = code.index + code[0].length
  }
  if (at < line.length) parts.push({ text: line.slice(at), style })
  return parts
}

function withOutput(run: CommandRun, text: string): CommandRun {
  const pieces = (run.partial + text).split('\n')
  const partial = pieces.pop() ?? ''
  const lines = [...run.lines, ...pieces.map(clean)]
  const dropped = Math.max(0, lines.length - KEEP_LINES)
  return { ...run, partial, lines: lines.slice(dropped), firstLine: (run.firstLine ?? 0) + dropped }
}

const outputOf = (run: CommandRun) => (run.partial === '' ? run.lines : [...run.lines, clean(run.partial)])

const currentRun = (list: CommandRun[], shownId: string) => list.find(run => run.id === shownId) ?? list.at(-1)

async function show($: EngineInterface, id: string) {
  await update($, shown, () => id)
  await update($, scrollEnd, () => -1)
}

async function changeRun($: EngineInterface, id: string, fn: (run: CommandRun) => CommandRun) {
  await update($, runs, list => list.map(run => (run.id === id ? fn(run) : run)))
}

const isLive = (run: CommandRun) => run.status === 'running' || run.status === 'stopping'

async function start($: EngineInterface, command: string, cwd: string | undefined) {
  const at = await $.clock.now()
  const run: CommandRun = {
    id: `${at.toString(36)}-${++runCount}`,
    command,
    cwd,
    status: 'running',
    startedAt: at,
    lines: [],
    partial: '',
  }
  await update($, runs, list => {
    const all = [...list, run]
    const extra = all.length - KEEP_RUNS
    if (extra <= 0) {
      return all
    }
    const dropped = new Set(all.filter(one => !isLive(one)).slice(0, extra).map(one => one.id))
    return all.filter(one => !dropped.has(one.id))
  })
  await show($, '')
  await update($, now, () => at)
  void $.ui.open({ id: PANE, title: TITLE })
  await new Promise<void>(started => void follow($, run.id, command, cwd, started))
  return (await read($, runs)).find(one => one.id === run.id) ?? run
}

/** Streams a run's output into its record; `started` once its process group is known or it has ended. */
async function follow($: EngineInterface, id: string, command: string, cwd: string | undefined, started: () => void) {
  const shell = (await $.env.get('SHELL')) ?? '/bin/sh'
  const child = $.process.spawn({
    argv: ['/usr/bin/perl', '-e', WRAPPER, '/usr/bin/script', '-q', '/dev/null', shell, '-c', command],
    cwd,
    env: NO_PAGER,
  })
  let hasPid = false
  try {
    for await (const { stream, text } of child) {
      let out = text
      if (!hasPid && stream === 'stderr') {
        const mark = PID_MARK.exec(out)
        if (mark !== null) {
          hasPid = true
          out = out.replace(mark[0], '')
          const pid = Number(mark[1])
          await changeRun($, id, run => ({ ...run, pid }))
          started()
        }
      }
      if (out !== '') {
        await changeRun($, id, run => withOutput(run, out))
      }
    }
    const { code, signal } = await child.result
    const at = await $.clock.now()
    await changeRun($, id, run => ({
      ...run,
      status: run.status === 'stopping' ? 'stopped' : code === 0 ? 'succeeded' : 'failed',
      exitCode: code ?? undefined,
      signal: signal ?? undefined,
      endedAt: at,
    }))
  } catch (error) {
    const at = await $.clock.now()
    await changeRun($, id, run => ({
      ...withOutput(run, `\ncould not run: ${error instanceof Error ? error.message : String(error)}\n`),
      status: 'failed',
      endedAt: at,
    }))
  } finally {
    started()
  }
}

/** Signals a run's process group and the group of the terminal `script` opened for it. */
async function signalRun($: EngineInterface, pid: number, signal: 'TERM' | 'KILL') {
  const { stdout } = await $.process.run(['/usr/bin/pgrep', '-P', String(pid)])
  const groups = [pid, ...stdout.split(/\s+/).filter(Boolean).map(Number)]
  await $.process.run(['/bin/kill', '-s', signal, '--', ...groups.map(group => `-${group}`)])
}

/** Stops a run: TERM first, KILL when it is already stopping. */
async function stop($: EngineInterface, id: string) {
  const run = (await read($, runs)).find(one => one.id === id)
  if (run === undefined || !isLive(run) || run.pid === undefined) {
    return
  }
  const signal = run.status === 'stopping' ? 'KILL' : 'TERM'
  await changeRun($, id, one => ({ ...one, status: 'stopping' }))
  await signalRun($, run.pid, signal)
}

/** Ends what an earlier load of the module left running: its stream went with it. */
async function stopOrphans($: EngineInterface, why: string) {
  const at = await $.clock.now()
  for (const run of await read($, runs)) {
    if (!isLive(run)) {
      continue
    }
    if (run.pid !== undefined) {
      await signalRun($, run.pid, 'TERM').catch(() => undefined)
    }
    await changeRun($, run.id, one => ({ ...withOutput(one, `\n(${why})\n`), status: 'stopped', endedAt: at }))
  }
}

/** Whether the person's permission settings let the command run, as they would for Bash. */
async function mayRun($: EngineInterface, command: string): Promise<string | undefined> {
  const { decision, reason } = await $.tool.check({ tool: 'Bash', input: { command } })
  if (decision === 'allow') {
    return undefined
  }
  if (decision === 'deny') {
    return reason ?? 'The permission settings refuse this command.'
  }
  const answer = await $.ui
    .ask(`Run \`${command}\` in the Commands panel?`, { header: 'Run command', options: ['Run', "Don't run"] })
    .catch(() => undefined)
  return answer === 'Run' ? undefined : 'The person chose not to run it.'
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const SPIN = ['◐', '◓', '◑', '◒']

const PROMPT = (what: string) =>
  `Run this in my Commands side panel: ${what}\n\n` +
  `Work out the shell command and start it with the ${RUN_TOOL} tool, which streams its output into the panel. ` +
  "Don't run it any other way, and don't wait for it or check on it unless I ask."

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await stopOrphans($, 'stopped: the command runner reloaded')

    $.clock.every(1000, () => {
      void (async () => {
        if ((await read($, runs)).some(isLive)) {
          const at = await $.clock.now()
          await update($, now, () => at)
        }
      })().catch(() => undefined)
    })

    await $.tool.register({
      name: 'run',
      description:
        "Starts a shell command in the person's Commands side panel, where its output streams live and they can stop it. " +
        'Use it when the person asks to run something in the panel (their /run-command). ' +
        'It returns at once, without the output: do not wait for the command, poll it, or run it again another way.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: "The shell command, run with the person's shell (-c)" },
          cwd: { type: 'string', description: "Working directory, absolute or relative to the session's; default the session's" },
        },
        required: ['command'],
      },
      isDeferred: true,
    })
    await $.command.register({
      name: 'run-command',
      description: 'Ask Claude to run something in the Commands panel, its output streaming there',
      argumentHint: '<what to run>',
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopOrphans($, 'stopped: the session ended').catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'run-command' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const what = e.args.trim()
    if (what === '') {
      return { text: 'Commands panel opened. Add what to run: /run-command <what to run>' }
    }
    // A command.run hook may not submit: the prompt would wait on the turn it holds.
    $.clock.after(0, () => void $.prompt.submit({ text: PROMPT(what), asUser: true }).catch(() => undefined))
    return {}
  })

  on('tool.call', { tool: RUN_TOOL }, async ($, e) => {
    const { command, cwd } = e as unknown as { command?: unknown; cwd?: unknown }
    if (typeof command !== 'string' || command.trim() === '') {
      return { deny: 'command is the shell command to run.' }
    }
    const refused = await mayRun($, command)
    if (refused !== undefined) {
      return { deny: refused }
    }
    const run = await start($, command, typeof cwd === 'string' && cwd !== '' ? cwd : undefined)
    if (run.status === 'failed') {
      return { deny: `It did not start: ${run.lines.at(-1) ?? 'no reason given'}` }
    }
    return { result: `Started in the Commands panel: ${command}` }
  }).catch(() => ({ deny: 'The command runner could not start it.' }))

  // The pane scrolls its output itself, so it can follow the newest lines and
  // hold still while scrolled back.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const run = currentRun(await read($, runs), await read($, shown))
    if (run === undefined) {
      return {}
    }
    const first = run.firstLine ?? 0
    const length = outputOf(run).length
    const total = first + length
    const end = await read($, scrollEnd)
    const moved = Math.max(first + Math.min(lastRoom, length), (end < 0 ? total : end) + e.by)
    await update($, scrollEnd, () => (moved >= total ? -1 : moved))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, runs)
    const at = await read($, now)
    const current = currentRun(list, await read($, shown))

    if (current === undefined) {
      return (
        <Text dimColor italic>
          Nothing run yet: /run-command &lt;what to run&gt;
        </Text>
      )
    }

    const glyph = (run: CommandRun): [string, string | undefined] => {
      switch (run.status) {
        case 'running':
          return [SPIN[Math.floor(at / 1000) % SPIN.length] ?? '◐', 'claude']
        case 'stopping':
          return ['◌', 'warning']
        case 'succeeded':
          return ['✓', 'success']
        case 'failed':
          return ['✗', 'error']
        case 'stopped':
          return ['■', 'warning']
      }
    }
    const facts = (run: CommandRun) =>
      [
        duration((run.endedAt ?? Math.max(at, run.startedAt)) - run.startedAt),
        run.signal ?? (run.exitCode !== undefined && run.exitCode !== 0 ? `exit ${run.exitCode}` : undefined),
      ]
        .filter(Boolean)
        .join(' · ')

    const header = (run: CommandRun) => {
      const [mark, color] = glyph(run)
      const isShown = run.id === current.id
      return (
        <Box key={`run-${run.id}`} flexDirection="row" gap={1}>
          <Text color={color}>{mark}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Button key={`show-${run.id}`} plain onPress={() => void show($, run.id)}>
              <Text bold={isShown} dimColor={!isShown} wrap="truncate-end">
                $ {run.command}
              </Text>
            </Button>
          </Box>
          <Text dimColor>{facts(run)}</Text>
          {isLive(run) && run.pid !== undefined && (
            <Button key={`stop-${run.id}`} plain onPress={() => void stop($, run.id)}>
              <Text color="error">{run.status === 'stopping' ? '[kill]' : '[stop]'}</Text>
            </Button>
          )}
        </Box>
      )
    }

    const width = Math.max(20, e.props.bodyColumns)
    const others = list.filter(run => run.id !== current.id).slice(-8)
    const output = outputOf(current)
    const first = current.firstLine ?? 0
    const total = first + output.length
    const wantedEnd = await read($, scrollEnd)
    const isFollowing = wantedEnd < 0 || wantedEnd >= total
    // The pane's rows less the headers, the rules, the cwd row, the clear row
    // and, scrolled back, the row saying so.
    const room = Math.max(3, e.props.scroll.bodyRows - others.length - 5 - (isFollowing ? 0 : 1))
    lastRoom = room
    const end = isFollowing ? total : Math.max(first + Math.min(room, output.length), wantedEnd)
    const start = Math.max(first, end - room)
    const hasFinished = list.some(run => !isLive(run))

    return (
      <Box flexDirection="column">
        {others.map(header)}
        {others.length > 0 && <Text color="subtle">{'─'.repeat(width)}</Text>}
        {header(current)}
        {current.cwd !== undefined && <Text dimColor wrap="truncate-end">  in {current.cwd}</Text>}
        <Text color="subtle">{'─'.repeat(width)}</Text>
        {output.length === 0 ? (
          <Text dimColor italic>
            {isLive(current) ? 'No output yet.' : 'No output.'}
          </Text>
        ) : (
          output.slice(start - first, end - first).map((line, i) => {
            const parts = styled(line)
            const n = start + i
            return (
              <Text key={`line-${n}`} wrap="truncate-end">
                {parts.length === 0
                  ? ' '
                  : parts.map((part, j) => (
                      <Text key={`part-${n}-${j}`} {...part.style}>
                        {part.text}
                      </Text>
                    ))}
              </Text>
            )
          })
        )}
        {!isFollowing && (
          <Box key="scrolled" flexDirection="row" gap={1}>
            <Text dimColor>↓ {total - end} newer lines</Text>
            <Button key="latest" plain onPress={() => void update($, scrollEnd, () => -1)}>
              <Text color="claude">[latest]</Text>
            </Button>
          </Box>
        )}
        {hasFinished && (
          <Button
            key="clear"
            plain
            onPress={() => {
              void update($, runs, all => all.filter(isLive))
              void show($, '')
            }}
          >
            <Text color="subtle">✕ clear finished</Text>
          </Button>
        )}
      </Box>
    )
  })
}
