import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const CWD = '/projects/game'
const PANE = {
  component: 'Pane',
  requestId: 'idea-queue',
  props: {
    title: 'Ideas',
    isFocused: true,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

/** Answers what the mod asks of the engine, recording prompts and the status line. */
function engine(on: On) {
  const seen = { prompts: [] as string[], status: undefined as string | undefined }
  mock.store(on)
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__idea-queue__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

async function listed($: Engine): Promise<string> {
  const { result } = await $.tool.call({ tool: 'mcp__idea-queue__ideas_list' })
  return String(result)
}

test('ideas added in the pane reach the session, which ticks them off', async ($, on) => {
  const seen = engine(on)
  await start($)

  const ui = await $.ui.mount({ plugin: 'idea-queue', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /Jot down ideas/ })).toBeDefined()

  await ui.input({ key: 'new', text: 'Embed the fonts and sounds' })
  await ui.input({ key: 'new', text: '   ' })
  await ui.input({ key: 'new', text: 'Split the game into crates' })
  await ui.input({ key: 'new', text: 'Add a Linux build' })
  expect(await ui.find({ text: /Embed the fonts and sounds/ })).toBeDefined()
  expect(await ui.find({ text: /3 queued/ })).toBeDefined()
  expect(seen.status).toBe('3 ideas queued')

  const list = await listed($)
  expect(list).toContain('Embed the fonts and sounds')
  const id = /\[id ([^\]]+)\] Split/.exec(list)?.[1] ?? ''

  await $.tool.call({ tool: 'mcp__idea-queue__ideas_update', id, status: 'started' })
  expect(await ui.find({ text: /the session is on it/ })).toBeDefined()
  expect(await ui.find({ key: `send-${id}` })).toBeUndefined()

  await $.tool.call({ tool: 'mcp__idea-queue__ideas_update', id, status: 'done' })
  expect(await listed($)).not.toContain('Split the game into crates')
  expect(seen.status).toBe('2 ideas queued')

  await ui.press({ key: 'work' })
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('idea queue')
  await ui.unmount()
})

test('one idea sent on its own becomes a prompt of its own', async ($, on) => {
  const seen = engine(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'idea-queue', surface: 'terminal', ...PANE })
  await ui.input({ key: 'new', text: 'Embed the fonts and sounds' })
  await ui.input({ key: 'new', text: 'Add a Linux build' })

  const id = /\[id ([^\]]+)\] Add a Linux/.exec(await listed($))?.[1] ?? ''
  await ui.press({ key: `send-${id}` })
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('Add a Linux build')
  expect(seen.prompts[0]).toContain(id)
  expect(await ui.find({ text: /sent, waiting for the session/ })).toBeDefined()
  expect(await ui.find({ key: `send-${id}` })).toBeUndefined()
  expect(await listed($)).toContain('(sent to you on its own, coming up) Add a Linux build')
  // One idea left waiting: no "work through all".
  expect(await ui.find({ key: 'work' })).toBeUndefined()
  await ui.unmount()
})

test('the session can queue ideas for later', async ($, on) => {
  const seen = engine(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'idea-queue', surface: 'terminal', ...PANE })
  await ui.input({ key: 'new', text: 'Typed in the pane' })

  const answer = await $.tool.call({ tool: 'mcp__idea-queue__ideas_add', ideas: ['Ley Spike', '  ', 'Afterimage'] })
  expect(String(answer.result)).toContain('3 in the queue')
  expect(await ui.find({ text: /Afterimage/ })).toBeDefined()
  expect(seen.status).toBe('3 ideas queued')
  expect(await listed($)).toMatch(/Typed in the pane[\s\S]*Ley Spike[\s\S]*Afterimage/)
  expect(seen.prompts).toHaveLength(0)

  const empty = await $.tool.call({ tool: 'mcp__idea-queue__ideas_add', ideas: [' '] })
  expect(empty.deny).toContain('at least one idea')
  await ui.unmount()
})

test('the session is told when an id is wrong', async ($, on) => {
  engine(on)
  await start($)
  const answer = await $.tool.call({ tool: 'mcp__idea-queue__ideas_update', id: 'nope', status: 'done' })
  expect(answer.deny).toContain('No queued idea')
})

test('ideas stay with their project across sessions', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'idea-queue', surface: 'desktop', ...PANE })
  await ui.input({ key: 'new', text: 'Kept for later' })
  await ui.unmount()

  await start($)
  expect(await listed($)).toContain('Kept for later')
})
