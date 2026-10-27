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

  await ui.press({ key: 'toggle-loop:main' })
  expect(await ui.find({ text: /Main session/ })).toBeDefined()
  expect(await ui.find({ text: /Build the game/ })).toBeUndefined()
  expect(await ui.find({ text: /Explore the repo/ })).toBeUndefined()
  await ui.unmount()
})
