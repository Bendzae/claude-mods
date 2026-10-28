import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Idea } from '../types'

// The queue: ideas the person adds in the pane while the session works on
// something else, kept per project (the session's directory) across sessions
// in the store. One can be sent to the session on its own, or the session
// works through them all: it reads them through `ideas_list` and ticks them
// off through `ideas_update`. The session can queue ideas too (`ideas_add`),
// when the person asks it to keep something for later.

const PANE = 'idea-queue'
const TITLE = 'Ideas'
const ideas = atom({ plugin: 'idea-queue', key: 'ideas' } as const, [])
const editing = atom({ plugin: 'idea-queue', key: 'editing' } as const, '')

const LIST = 'mcp__idea-queue__ideas_list'
const UPDATE = 'mcp__idea-queue__ideas_update'
const ADD = 'mcp__idea-queue__ideas_add'

const WORK_PROMPT =
  'Work through the ideas in my idea queue. Decide the order yourself, tell me the order before you start, and tick each one off as you finish it.'

/** The store key of this project's queue. */
async function storeKey($: EngineInterface): Promise<string> {
  return `queue:${await $.session.cwd()}`
}

function asIdeas(value: unknown): Idea[] {
  return Array.isArray(value) ? (value as Idea[]) : []
}

function showCount($: EngineInterface, list: Idea[]) {
  $.ui.status(list.length === 0 ? undefined : `${list.length} idea${list.length === 1 ? '' : 's'} queued`)
}

/** Changes the queue as the store has it now (another session may have added
 * to it), then keeps the result in the store and in the pane's state. */
async function change($: EngineInterface, fn: (list: Idea[]) => Idea[]): Promise<Idea[]> {
  const key = await storeKey($)
  const changed = fn(asIdeas(await $.store.get(key)))
  await $.store.set(key, changed)
  await update($, ideas, () => changed)
  showCount($, changed)
  return changed
}

/** Picks up what other sessions in this project changed. */
async function sync($: EngineInterface) {
  const stored = asIdeas(await $.store.get(await storeKey($)))
  const shown = await read($, ideas)
  if (JSON.stringify(stored) !== JSON.stringify(shown)) {
    await update($, ideas, () => stored)
    showCount($, stored)
  }
}

function newIdea(text: string): Idea {
  return { id: crypto.randomUUID().slice(0, 8), text, isStarted: false }
}

/** How an idea's state shows in the pane: a glyph before it, a line under it. */
function mark(idea: Idea): { glyph: string; label: string; color: 'subtle' | 'suggestion' | 'warning' } {
  if (idea.isStarted) {
    return { glyph: '●', label: 'the session is on it', color: 'warning' }
  }
  if (idea.isSent) {
    return { glyph: '↗', label: 'sent, waiting for the session', color: 'suggestion' }
  }
  return { glyph: '○', label: '', color: 'subtle' }
}

/** The prompt an idea sent on its own becomes: the idea as typed, and how to tick it off. */
function sendPrompt(idea: Idea): string {
  return `${idea.text}\n\n(From my idea queue, id ${idea.id}: mark it started and done with ideas_update.)`
}

function describe(list: Idea[]): string {
  if (list.length === 0) {
    return 'The idea queue is empty.'
  }
  const lines = list.map((idea, i) => {
    const state = idea.isStarted ? ' (started)' : idea.isSent ? ' (sent to you on its own, coming up)' : ''
    return `${i + 1}. [id ${idea.id}]${state} ${idea.text}`
  })
  return `Queued ideas, in the order they were added (not an order to do them in):\n${lines.join('\n')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await sync($)
    $.clock.every(5000, () => void sync($))

    await $.command.register({
      name: 'ideas',
      description: 'Open the idea queue: ideas for the session to work through later',
    })
    await $.tool.register({
      name: 'ideas_list',
      description:
        "The person's idea queue: ideas they added in the Ideas side panel for later, while you were busy. " +
        'Read it when they ask you to work through their ideas or the queue, or ask what is queued. ' +
        'Then decide the order yourself (what unblocks what, related changes together, small and safe ones early unless something is urgent), ' +
        'say the order and why in a line or two, and work through them one at a time: ideas_update with "started" as you begin one, ' +
        '"done" once it is finished (done takes it off the queue). Ask before starting one that is unclear. ' +
        'Leave out ideas marked as sent on their own: they come to you as prompts of their own. ' +
        'Read the list again after each idea: the person may add more meanwhile.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'ideas_update',
      description:
        'Marks a queued idea (by its id from ideas_list) as started, so the person sees what you are on, or done, which takes it off the queue.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The idea id from ideas_list' },
          status: { type: 'string', enum: ['started', 'done'] },
        },
        required: ['id', 'status'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'ideas_add',
      description:
        "Adds ideas to the end of the person's idea queue, for later. Use it when they ask you to queue, park or keep something " +
        'for later. Write each idea so it stands on its own: what to do and why, enough to act on in a later session ' +
        'without this conversation. Do not start on them: they wait until the person sends one or asks you to work through the queue.',
      inputSchema: {
        type: 'object',
        properties: {
          ideas: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'The ideas to add, one entry each, in the order to list them',
          },
        },
        required: ['ideas'],
      },
      isDeferred: false,
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'ideas' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Idea queue opened.' }
  })

  on('tool.call', { tool: LIST }, async $ => {
    await sync($)

    return { result: describe(await read($, ideas)) }
  }).catch(() => ({ deny: 'The idea queue could not be read just now.' }))

  on('tool.call', { tool: UPDATE }, async ($, e) => {
    const { id, status } = e as unknown as { id?: unknown; status?: unknown }
    const list = await read($, ideas)
    if (typeof id !== 'string' || !list.some(idea => idea.id === id)) {
      return { deny: `No queued idea has the id ${String(id)}; read ideas_list for the ids.` }
    }
    if (status !== 'started' && status !== 'done') {
      return { deny: 'status is "started" or "done".' }
    }
    const left = await change($, all =>
      status === 'done'
        ? all.filter(idea => idea.id !== id)
        : all.map(idea => (idea.id === id ? { ...idea, isStarted: true } : idea)),
    )

    return { result: status === 'done' ? `Done; ${left.length} left in the queue.` : 'Marked as started.' }
  }).catch(() => ({ deny: 'The idea queue could not be changed just now.' }))

  on('tool.call', { tool: ADD }, async ($, e) => {
    const { ideas: given } = e as unknown as { ideas?: unknown }
    const texts = Array.isArray(given)
      ? given.filter((text): text is string => typeof text === 'string').map(text => text.trim()).filter(text => text !== '')
      : []
    if (texts.length === 0) {
      return { deny: 'ideas is a list of at least one idea, each a non-empty string.' }
    }
    const added = texts.map(newIdea)
    const all = await change($, list => [...list, ...added])

    return {
      result: `Added ${added.map(idea => `[id ${idea.id}] ${idea.text}`).join('; ')}. ${all.length} in the queue.`,
    }
  }).catch(() => ({ deny: 'The idea queue could not be changed just now.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, ideas)
    const editingId = await read($, editing)
    const waiting = list.filter(idea => !idea.isSent && !idea.isStarted)

    const add = (text: string) => {
      const trimmed = text.trim()
      if (trimmed !== '') {
        void change($, all => [...all, newIdea(trimmed)])
      }
    }
    const remove = (id: string) => void change($, all => all.filter(idea => idea.id !== id))
    const send = (idea: Idea) => {
      void $.prompt.submit({ text: sendPrompt(idea), asUser: true })
      void change($, all => all.map(one => (one.id === idea.id ? { ...one, isSent: true } : one)))
      $.ui.toast('Sent: it runs as soon as the session is free.')
    }
    const edit = (id: string) => {
      void update($, editing, () => id)
      // The keyboard to the field, where the surface has one to move.
      void $.ui.focus({ requestId: PANE, key: `edit-${id}` }).catch(() => undefined)
    }
    const stopEditing = () => void update($, editing, () => '')
    const save = (id: string, text: string) => {
      const trimmed = text.trim()
      if (trimmed !== '') {
        void change($, all => all.map(one => (one.id === id ? { ...one, text: trimmed } : one)))
      }
      stopEditing()
    }
    const workThrough = () => {
      void $.prompt.submit({ text: WORK_PROMPT, asUser: true })
      $.ui.toast('The session works through the queue once it is free.')
    }

    let field = null
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      field = (
        <Box borderStyle="round" borderColor="promptBorder" paddingX={1}>
          <Input key="new" label="+ " placeholder="An idea for later…" value="" submitLabel="add" autoFocus onSubmit={add} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="claude">
            ✦ Idea queue
          </Text>
          <Text dimColor>{list.length === 0 ? 'empty' : `${list.length} queued`}</Text>
        </Box>
        {field}
        {list.length === 0 ? (
          <Box flexDirection="column" paddingX={1}>
            <Text dimColor italic>
              Jot down ideas here while the session works.
            </Text>
            <Text dimColor italic>
              Send one on its own, or let the session work through them all.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {list.map((idea, i) => {
              const state = mark(idea)
              const canEdit = !idea.isSent && !idea.isStarted
              if (canEdit && idea.id === editingId && e.surface !== 'mobile') {
                const { Input } = $.ui.resolve(e)
                return (
                  <Box key={`idea-${idea.id}`} flexDirection="row" gap={1} paddingX={1}>
                    <Text color="claude">✎</Text>
                    <Box flexGrow={1} flexShrink={1} borderStyle="round" borderColor="claude" paddingX={1}>
                      <Input
                        key={`edit-${idea.id}`}
                        value={idea.text}
                        submitLabel="save"
                        autoFocus
                        onSubmit={text => save(idea.id, text)}
                      />
                    </Box>
                    <Button key={`cancel-${idea.id}`} plain label="cancel" onPress={stopEditing} />
                  </Box>
                )
              }
              return (
                <Box
                  key={`idea-${idea.id}`}
                  flexDirection="row"
                  gap={1}
                  paddingX={1}
                  hover={{ backgroundColor: 'inactive' }}
                >
                  <Text color={state.color}>{state.glyph}</Text>
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Text>
                      <Text dimColor>{i + 1}. </Text>
                      {idea.text}
                    </Text>
                    {state.label !== '' && (
                      <Text color={state.color} italic>
                        {state.label}
                      </Text>
                    )}
                  </Box>
                  {canEdit && <Button key={`edit-btn-${idea.id}`} plain label="✎" onPress={() => edit(idea.id)} />}
                  {canEdit && <Button key={`send-${idea.id}`} plain label="send ↗" onPress={() => send(idea)} />}
                  <Button key={`remove-${idea.id}`} plain label="×" onPress={() => remove(idea.id)} />
                </Box>
              )
            })}
          </Box>
        )}
        {waiting.length > 1 && (
          <Box paddingX={1}>
            <Button key="work" variant="primary" label={`Work through all ${waiting.length}`} onPress={workThrough} />
          </Box>
        )}
      </Box>
    )
  })
}
