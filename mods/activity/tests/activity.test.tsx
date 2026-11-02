import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const PANE = {
  component: 'Pane',
  requestId: 'activity',
  props: {
    title: 'Activity',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Agent = { id: string; description: string; type: string; status: string; parentId?: string }

/** Stands in for the engine: tools answer as the real ones do, agents come from `agents`. */
function engine(on: On, agents: Agent[]) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [], cost: { usd: 1.5 } } as never }))
  on('agent.list', () => ({ value: agents as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('fs.stat', (_$, e) => (e.path === '/tmp/b1.output' ? { value: { size: 100 } as never } : { deny: 'missing' }))
  on('fs.read', (_$, e) =>
    e.path === '/tmp/b1.output'
      ? { value: 'Compiling a\n\u001b[32mCompiling b\u001b[0m\nCompiling c\n' as never }
      : { deny: 'missing' },
  )
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') {
      return {
        result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } as never,
        text: 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output. You will be notified when it completes.',
      }
    }
    return { result: {} as never, text: '' }
  })
  return clock
}

/** Stands in for the engine with every Bash call run in the foreground. */
function foreground(on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } as never }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } as never, text: 'ok' }))
  return clock
}

async function start($: Engine) {
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
}

test('tasks, a background shell with its output, and nested subagents', async ($, on) => {
  const agents: Agent[] = []
  const clock = engine(on, agents)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await start($)
  const ui = await $.ui.mount({ plugin: 'activity', surface: 'terminal', ...PANE })

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Write the mod', status: 'in_progress', activeForm: 'Writing the mod' },
      { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
    ],
  } as never)
  expect(await ui.find({ text: /Writing the mod/ })).toBeDefined()
  expect(await ui.find({ text: /33%/ })).toBeDefined()

  await $.tool.call({ tool: 'Bash', command: 'cargo build', description: 'Build the game', run_in_background: true } as never)
  expect(await ui.find({ text: /Build the game/ })).toBeDefined()
  expect(await ui.find({ text: /\$ cargo build/ })).toBeDefined()

  agents.push({ id: 'a1', description: 'Explore the repo', type: 'Explore', status: 'running' })
  agents.push({ id: 'a2', description: 'Nested helper', type: 'general-purpose', status: 'running', parentId: 'a1' })
  await clock.advance(2000)
  expect(await ui.find({ text: /Explore the repo · Explore/ })).toBeDefined()
  expect(await ui.find({ text: /Nested helper/ })).toBeDefined()
  expect(await ui.find({ text: /Compiling c/ })).toBeDefined()

  await $.session.append({
    message: {
      type: 'user',
      content: [{ type: 'text', text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' }],
    },
  } as never)
  agents[1] = { ...agents[1]!, status: 'completed' }
  await clock.advance(1000)
  // 1 of 3 tasks, the shell, and one of two agents: 3 of 6.
  expect(await ui.find({ text: /50%/ })).toBeDefined()
  await clock.advance(2000)
  // Its last lines stay once it has ended.
  expect(await ui.find({ text: /Compiling c/ })).toBeDefined()

  await ui.press({ key: 'clear' })
  expect(await ui.find({ text: /\$ cargo build/ })).toBeUndefined()
  expect(await ui.find({ text: /Nested helper/ })).toBeUndefined()
  await ui.unmount()
})

test('agents and shells fold away when clicked', async ($, on) => {
  const clock = engine(on, [{ id: 'a1', description: 'Explore the repo', type: 'Explore', status: 'running' }])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await start($)
  const ui = await $.ui.mount({ plugin: 'activity', surface: 'terminal', ...PANE })
  await $.tool.call({ tool: 'Bash', command: 'cargo build', description: 'Build the game', run_in_background: true } as never)
  await clock.advance(2000)
  expect(await ui.find({ text: /Compiling c/ })).toBeDefined()

  await ui.press({ key: 'toggle-shell:b1' })
  expect(await ui.find({ text: /Build the game/ })).toBeDefined()
  expect(await ui.find({ text: /Compiling c/ })).toBeUndefined()
  expect(await ui.find({ text: /\$ cargo build/ })).toBeUndefined()
  await ui.press({ key: 'toggle-shell:b1' })
  expect(await ui.find({ text: /Compiling c/ })).toBeDefined()

  // The main session folds apart from its subagents, which are a group of their own.
  await ui.press({ key: 'toggle-loop:main' })
  expect(await ui.find({ text: /Main session/ })).toBeDefined()
  expect(await ui.find({ text: /Build the game/ })).toBeUndefined()
  expect(await ui.find({ text: /Explore the repo/ })).toBeDefined()
  expect(await ui.find({ text: /Subagents/ })).toBeDefined()
  await ui.press({ key: 'toggle-group:agents' })
  expect(await ui.find({ text: /Subagents/ })).toBeDefined()
  expect(await ui.find({ text: /Explore the repo/ })).toBeUndefined()
  await ui.unmount()
})

test('a foreground command shows its command and how long it has run', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } as never }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  let finish = () => {}
  on('tool.call', async (_$, e) => {
    if ((e as unknown as { command?: string }).command === 'ls') {
      return { result: { stdout: 'a b', stderr: '', interrupted: false } as never, text: 'a b' }
    }
    await new Promise<void>(resolve => {
      finish = resolve
    })
    return { result: { stdout: 'Compiling game\nFinished release', stderr: '', interrupted: false } as never, text: 'ok' }
  })
  await start($)
  const ui = await $.ui.mount({ plugin: 'activity', surface: 'terminal', ...PANE })

  const call = $.tool.call({ tool: 'Bash', command: 'cargo build --release', description: 'Build the game' } as never)
  await clock.advance(65000)
  expect(await ui.find({ text: /^▾ [◐◓◑◒] Build the game$/ })).toBeDefined()
  expect(await ui.find({ text: /\$ cargo build --release/ })).toBeDefined()
  expect(await ui.find({ text: /^1m 05s$/ })).toBeDefined()

  finish()
  await call
  expect(await ui.find({ text: /^▾ [◐◓◑◒] Build the game$/ })).toBeUndefined()
  // Kept once done, having run a while: its command, time and last lines.
  expect(await ui.find({ text: /^Build the game$/ })).toBeDefined()
  expect(await ui.find({ text: /\$ cargo build --release/ })).toBeDefined()
  expect(await ui.find({ text: /Finished release/ })).toBeDefined()

  // The next one is kept too, open; the one before folds away.
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' } as never)
  expect(await ui.find({ text: /^List files$/ })).toBeDefined()
  expect(await ui.find({ text: /a b/ })).toBeDefined()
  expect(await ui.find({ text: /^Build the game$/ })).toBeDefined()
  expect(await ui.find({ text: /Finished release/ })).toBeUndefined()

  // Clicked open, it stays open.
  const fold = await ui.find({ type: 'Button', text: /Build the game/ })
  expect(fold?.key).toMatch(/^toggle-shell:fg-/)
  await ui.press({ key: fold?.key ?? '' })
  expect(await ui.find({ text: /Finished release/ })).toBeDefined()

  // Its clipboard button copies the whole output.
  await ui.press({ key: (fold?.key ?? '').replace('toggle-shell:', 'copy-') })
  await clock.advance(10)
  expect(copied).toEqual(['Compiling game\nFinished release'])

  // And the one on its command line copies the command.
  await ui.press({ key: (fold?.key ?? '').replace('toggle-shell:', 'copy-cmd-') })
  await clock.advance(10)
  expect(copied.at(-1)).toBe('cargo build --release')
  await ui.unmount()
})

test('the oldest finished commands are left out when the pane is full', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } as never }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('tool.call', (_$, e) => {
    const command = (e as unknown as { command?: string }).command ?? ''
    return { result: { stdout: `out of ${command}`, stderr: '', interrupted: false } as never, text: '' }
  })
  await start($)
  const small = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } } }
  const ui = await $.ui.mount({ plugin: 'activity', surface: 'terminal', ...small })
  for (let i = 1; i <= 10; i += 1) {
    await $.tool.call({ tool: 'Bash', command: `step ${i}`, description: `Step ${i}` } as never)
    await clock.advance(1000)
  }
  expect(await ui.find({ text: /^Step 10$/ })).toBeDefined()
  expect(await ui.find({ text: /out of step 10/ })).toBeDefined()
  expect(await ui.find({ text: /^Step 1$/ })).toBeUndefined()
  expect(await ui.find({ text: /older commands hidden/ })).toBeDefined()
  await ui.unmount()
})

test('long commands and output lines wrap, up to a few lines', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } as never }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const long = `cargo build --release --target aarch64-apple-darwin --features ${'x,'.repeat(20)}end`
  const output = `warning: ${'unused '.repeat(12)}import`
  const huge = 'y'.repeat(400)
  on('tool.call', () => ({ result: { stdout: `${output}\n${huge}`, stderr: '', interrupted: false } as never, text: '' }))
  await start($)
  const ui = await $.ui.mount({ plugin: 'activity', surface: 'terminal', ...PANE })
  await $.tool.call({ tool: 'Bash', command: long, description: 'Build' } as never)

  expect(long.length).toBeGreaterThan(60)
  expect(await ui.find({ text: new RegExp(`${long.slice(-20)}$`) })).toBeDefined()
  expect(await ui.find({ text: /unused import$/ })).toBeDefined()
  // Past two lines an output line is cut.
  expect(await ui.find({ text: /^│ y+…$/ })).toBeDefined()
  await ui.unmount()
})

test('a command run without a description is labelled by the command itself', async ($, on) => {
  engine(on, [])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await start($)
  const ui = await $.ui.mount({ plugin: 'activity', surface: 'terminal', ...PANE })

  await $.tool.call({ tool: 'Bash', command: 'git status --short' } as never)
  expect(await ui.find({ text: /^Command$/ })).toBeUndefined()
  expect(await ui.find({ text: /^\$ git status --short$/ })).toBeDefined()
  // Not again on a row of its own under the label.
  expect(await ui.find({ text: /^git status --short$/ })).toBeUndefined()
  await ui.unmount()
})

test('commands without a description get one from a small model, in a batch', async ($, on) => {
  const clock = foreground(on)
  const asked: { model: string; ids: string[] }[] = []
  on('model.complete', (_$, e) => {
    const commands = JSON.parse(String(e.prompt)) as { id: string; command: string }[]
    asked.push({ model: e.model, ids: commands.map(c => c.id) })
    const titles = Object.fromEntries(commands.map(c => [c.id, c.command.startsWith('git') ? 'Show changed files' : 'Count lines']))
    return { value: { isAnswered: true, text: `Here: ${JSON.stringify(titles)}`, usage: {} } as never }
  })
  await start($)
  const ui = await $.ui.mount({ plugin: 'activity', surface: 'terminal', ...PANE })

  await $.tool.call({ tool: 'Bash', command: 'git status --short' } as never)
  await $.tool.call({ tool: 'Bash', command: 'wc -l *.ts' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' } as never)
  expect(await ui.find({ text: /^\$ git status --short$/ })).toBeDefined()

  await clock.advance(10000)
  expect(asked).toHaveLength(1)
  expect(asked[0]?.model).toBe('haiku')
  expect(asked[0]?.ids).toHaveLength(2)
  expect(await ui.find({ text: /^Show changed files$/ })).toBeDefined()
  expect(await ui.find({ text: /^Count lines$/ })).toBeDefined()

  // Each is asked about once.
  await clock.advance(10000)
  expect(asked).toHaveLength(1)
  await ui.unmount()
})

test('a folded command keeps its label to one line', async ($, on) => {
  foreground(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'activity', surface: 'terminal', ...PANE })
  const long = `echo ${'word '.repeat(40)}`
  await $.tool.call({ tool: 'Bash', command: long } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' } as never)
  const label = await ui.find({ text: /^\$ echo word/ })
  expect(label?.props).toMatchObject({ wrap: 'truncate-end' })
  await ui.unmount()
})

test('the system prompt asks for a description on every Bash call', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash'],
    outputStyle: { name: 'default', isKeepingCodingInstructions: true },
    traits: [],
  } as never)
  expect(sections.map(section => section.id)).toEqual(['intro', 'activity:bash-descriptions'])
  expect(sections.at(-1)?.text).toContain('description')
})
