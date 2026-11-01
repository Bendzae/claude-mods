import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const RUN_TOOL = 'mcp__command-runner__run'

const PANE = {
  component: 'Pane',
  requestId: 'command-runner',
  props: {
    title: 'Commands',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** Stands in for the engine: `make` writes two lines and runs until killed; anything else exits 0 at once. */
function engine(on: On, decision: 'allow' | 'ask' | 'deny' = 'allow') {
  const clock = mock.clock(on)
  mock.store(on)
  const kills: string[][] = []
  const spawned: string[][] = []
  const prompts: string[] = []
  let killed = () => {}
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/bin/zsh' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__command-runner__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.check', () => ({ decision, reason: decision === 'deny' ? 'Bash(make:*) is denied' : undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { answers: { q: 'Run' } } as never, text: 'Run' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === '/usr/bin/pgrep') {
      return { value: { exitCode: 0, stdout: '4243\n', stderr: '' } as never }
    }
    kills.push([...e.argv])
    killed()
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    const command = e.argv.at(-1)
    yield { stream: 'stderr' as const, text: '__command_runner_pid__=4242\n' }
    if (command === 'many') {
      yield { stream: 'stdout' as const, text: Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`).join('') }
      return { value: { code: 0, signal: null } } as never
    }
    if (command !== 'make') {
      yield { stream: 'stdout' as const, text: 'done\n' }
      return { value: { code: 0, signal: null } } as never
    }
    yield { stream: 'stdout' as const, text: '\u001b[32mCompiling a\u001b[0m\nCompil' }
    yield { stream: 'stdout' as const, text: 'ing b\n' }
    await new Promise<void>(resolve => (killed = resolve))
    return { value: { code: null, signal: 'SIGTERM' } } as never
  })
  return { clock, kills, spawned, prompts }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
}

test('a run streams into the pane and the pane stops its process group', async ($, on) => {
  const { kills, spawned } = engine(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'command-runner', surface: 'terminal', ...PANE })

  const ran = await $.tool.call({ tool: RUN_TOOL, command: 'make' } as never)
  expect(ran.text ?? JSON.stringify(ran.result)).toContain('Started')
  expect(spawned[0]?.slice(-3)).toEqual(['/bin/zsh', '-c', 'make'])
  expect(await ui.find({ text: /\$ make/ })).toBeDefined()
  expect(await ui.find({ text: /^Compiling a$/ })).toMatchObject({ children: [{ props: { color: 'green' }, children: ['Compiling a'] }] })
  expect(await ui.find({ text: /^Compiling b$/ })).toBeDefined()
  expect(await ui.find({ text: /command_runner_pid/ })).toBeUndefined()
  expect(await ui.find({ text: /\u001b/ })).toBeUndefined()

  await ui.press({ key: 'stop-0-1' })
  expect(kills[0]).toEqual(['/bin/kill', '-s', 'TERM', '--', '-4242', '-4243'])
  expect(await ui.find({ text: /SIGTERM/ })).toBeDefined()
  expect(await ui.find({ text: /\[stop\]/ })).toBeUndefined()

  await ui.press({ key: 'clear' })
  expect(await ui.find({ text: /\$ make/ })).toBeUndefined()
  await ui.unmount()
})

test('/run-command hands the description to the model', async ($, on) => {
  const { clock, prompts } = engine(on)
  await start($)
  await $.command.run({ command: 'run-command', args: 'the frontend tests' })
  await clock.settle()
  expect(prompts[0]).toContain('Run this in my Commands side panel: the frontend tests')
  expect(prompts[0]).toContain(RUN_TOOL)
})

test('a command the permission settings deny does not run', async ($, on) => {
  const { spawned } = engine(on, 'deny')
  await start($)
  const ran = await $.tool.call({ tool: RUN_TOOL, command: 'make' } as never)
  expect(ran.deny).toContain('denied')
  expect(spawned).toHaveLength(0)
})

test('the output follows the newest lines, scrolls back, and jumps to the latest', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({
    plugin: 'command-runner',
    surface: 'terminal',
    ...PANE,
    props: { ...PANE.props, scroll: { offset: 0, bodyRows: 15 } },
  })
  await $.tool.call({ tool: RUN_TOOL, command: 'many' } as never)
  expect(await ui.find({ text: /^line 50$/ })).toBeDefined()
  expect(await ui.find({ text: /^line 41$/ })).toBeDefined()
  expect(await ui.find({ text: /^line 40$/ })).toBeUndefined()

  const scroll = { component: 'Pane', requestId: 'command-runner', offset: 0, origin: { kind: 'person' } }
  await $.ui.scroll({ ...scroll, by: -5 } as never)
  expect(await ui.find({ text: /^line 45$/ })).toBeDefined()
  expect(await ui.find({ text: /^line 46$/ })).toBeUndefined()
  expect(await ui.find({ text: /5 newer lines/ })).toBeDefined()

  await $.ui.scroll({ ...scroll, by: -100 } as never)
  expect(await ui.find({ text: /^line 1$/ })).toBeDefined()

  await ui.press({ key: 'latest' })
  expect(await ui.find({ text: /^line 50$/ })).toBeDefined()
  expect(await ui.find({ text: /newer lines/ })).toBeUndefined()
  await ui.unmount()
})

test('a run folds its output away, runs again in its place, and is deleted', async ($, on) => {
  const { spawned } = engine(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'command-runner', surface: 'terminal', ...PANE })
  await $.tool.call({ tool: RUN_TOOL, command: 'ls' } as never)
  const key = (await ui.find({ type: 'Button', text: /\$ ls/ }))?.key ?? ''
  const id = key.replace('show-', '')
  expect(await ui.find({ text: /^done$/ })).toBeDefined()

  await ui.press({ key })
  expect(await ui.find({ text: /^done$/ })).toBeUndefined()
  expect(await ui.find({ text: /\$ ls/ })).toBeDefined()
  await ui.press({ key })
  expect(await ui.find({ text: /^done$/ })).toBeDefined()

  await ui.press({ key: `rerun-${id}` })
  expect(spawned).toHaveLength(2)
  expect(await ui.find({ key: `show-${id}` })).toBeUndefined()
  const again = (await ui.find({ type: 'Button', text: /\$ ls/ }))?.key ?? ''
  expect(again).not.toBe(key)

  await ui.press({ key: again.replace('show-', 'delete-') })
  expect(await ui.find({ text: /\$ ls/ })).toBeUndefined()
  expect(await ui.find({ text: /Nothing run yet/ })).toBeDefined()
  await ui.unmount()
})
