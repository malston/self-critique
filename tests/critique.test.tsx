import type { On, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'self-critique',
  component: 'Pane',
  requestId: 'self-critique',
  props: {
    title: 'Self-Critique',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const REVIEW = JSON.stringify({
  verdict: 'Mixed',
  summary: 'Mostly right, oversold.',
  strengths: ['Clear steps'],
  flaws: [{ flaw: 'Agrees with the user without evidence', fix: 'Cite a source or hedge' }],
})

const EXCHANGE: SessionMessage[] = [
  { role: 'user', text: 'Is my plan good?', toolUses: [] },
  { role: 'assistant', text: 'Yes, it is great.', toolUses: [] },
]

const TURN = { answer: 'Yes, it is great.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }

// Fakes the transcript and the models, and records every reviewer call (a fork too, which no path should make).
function stubModels(on: On, reply = REVIEW, messages: SessionMessage[] = EXCHANGE, prompts: string[] = []) {
  const calls: string[] = []
  on('session.messages', () => ({ value: messages }))
  on('model.complete', (_, e) => {
    calls.push(`complete:${e.model}`)
    prompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: reply, usage: USAGE } }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.fork', () => {
    calls.push('fork')
    return { value: { isAnswered: true as const, text: reply, usage: USAGE } }
  })
  return calls
}

// The test runtime has timers; the hooks module's type library does not declare them.
const wait = (ms: number) =>
  new Promise(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => r(undefined), ms))

test('rerun on a picked model draws the review, and a fix sends a prompt', async ($, on) => {
  const asked: string[] = []
  const sent: string[] = []
  const calls = stubModels(on, `Here: ${REVIEW}`, EXCHANGE, asked)
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.select({ key: 'model', value: 'haiku' })
  await ui.press({ key: 'rerun' })

  expect(calls).toEqual(['complete:haiku'])
  expect(asked[0]).toContain('Yes, it is great.')
  expect((await ui.find({ type: 'Text', text: /Verdict/ }))?.text).toBe('Verdict: Mixed')
  expect(await ui.find({ type: 'Text', text: /Clear steps/ })).toBeDefined()

  await ui.press({ key: 'fix-0' })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Cite a source or hedge')
  await ui.unmount()
})

test('a reply that is not JSON shows an error, not a review', async ($, on) => {
  stubModels(on, 'no json here')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'model', value: 'sonnet' })
  await ui.press({ key: 'rerun' })

  expect(await ui.find({ type: 'Text', text: /valid JSON/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Verdict/ })).toBeUndefined()
  await ui.unmount()
})

test('finds the user request behind many tool-only rows', async ($, on) => {
  const asked: string[] = []
  const toolRows = Array.from({ length: 60 }, (_, i): SessionMessage => ({
    role: i % 2 ? 'user' : 'assistant',
    text: '',
    toolUses: [],
  }))
  stubModels(
    on,
    REVIEW,
    [{ role: 'user', text: 'Build the mod', toolUses: [] }, ...toolRows, { role: 'assistant', text: 'Done.', toolUses: [] }],
    asked,
  )

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(asked[0]).toContain('USER REQUEST:\nBuild the mod')
  await ui.unmount()
})

test('auto toggles', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'auto' })
  expect((await ui.find({ type: 'Button', key: 'auto' }))?.text).toMatch(/on/)
  await ui.unmount()
})

async function settle(ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<unknown> }) {
  // Auto and /critique start the review without awaiting it.
  for (let i = 0; i < 50 && !(await ui.find({ type: 'Text', text: /Verdict|failed|No response/ })); i++) {
    await wait(5)
  }
}

test('Same as session reviews on the session model without the conversation', async ($, on) => {
  const calls = stubModels(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(calls).toEqual(['complete:claude-opus-5-5'])
  expect(await ui.find({ type: 'Text', text: /Verdict: Mixed/ })).toBeDefined()
  await ui.unmount()
})

test('/critique registers, opens the pane and starts a review', async ($, on) => {
  const calls = stubModels(on)
  const registered: string[] = []
  const opened: string[] = []
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['critique'])

  const ran = await $.command.run({
    command: 'critique',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(opened).toEqual(['self-critique'])
  expect(ran.text).toMatch(/opened/)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await settle(ui)
  expect(calls).toHaveLength(1)
  await ui.unmount()
})

test('Auto on reviews a finished main-thread answer', async ($, on) => {
  const calls = stubModels(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'auto' })

  await $.turn.complete(TURN)
  await settle(ui)

  expect(calls).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /Verdict: Mixed/ })).toBeDefined()
  await ui.unmount()
})

test('Auto skips subagents, interrupted turns, and everything while off', async ($, on) => {
  const calls = stubModels(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.turn.complete(TURN) // Auto is off
  await ui.press({ key: 'auto' })
  await $.turn.complete({ ...TURN, agentId: 'sub-1' })
  await $.turn.complete({ ...TURN, reason: 'aborted', isAborted: true })
  await wait(50)

  expect(calls).toEqual([])
  await ui.unmount()
})

test('an API failure shows its reason', async ($, on) => {
  on('session.messages', () => ({ value: EXCHANGE }))
  on('model.complete', () => ({
    value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE },
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.select({ key: 'model', value: 'opus' })
  await ui.press({ key: 'rerun' })

  expect((await ui.find({ type: 'Text', text: /failed/ }))?.text).toBe('Review failed: api-error')
  await ui.unmount()
})

test('with no assistant text yet it says so and calls no model', async ($, on) => {
  const calls = stubModels(on, REVIEW, [{ role: 'user', text: 'hi', toolUses: [] }])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(await ui.find({ type: 'Text', text: /No response to review yet/ })).toBeDefined()
  expect(calls).toEqual([])
  await ui.unmount()
})

test('an unknown verdict is rejected', async ($, on) => {
  stubModels(on, JSON.stringify({ verdict: 'Great', summary: 'x' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })
  expect(await ui.find({ type: 'Text', text: /valid JSON/ })).toBeDefined()
  await ui.unmount()
})

test('a review with no strengths or flaws says so', async ($, on) => {
  stubModels(on, JSON.stringify({ verdict: 'Strong', summary: 'Solid.' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })
  expect(await ui.find({ type: 'Text', text: /Verdict: Strong/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /None listed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /None found/ })).toBeDefined()
  await ui.unmount()
})

test('a second Rerun while one runs does not start another review', async ($, on) => {
  let release: () => void = () => {}
  let count = 0
  on('session.messages', () => ({ value: EXCHANGE }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.complete', async () => {
    count++
    await new Promise<void>(r => (release = r))
    return { value: { isAnswered: true as const, text: REVIEW, usage: USAGE } }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = ui.press({ key: 'rerun' })
  await wait(10)
  await ui.press({ key: 'rerun' })
  release()
  await first

  expect(count).toBe(1)
  await ui.unmount()
})

test('the pane says which response it reviewed', async ($, on) => {
  stubModels(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect((await ui.find({ type: 'Text', text: /^Reviewed:/ }))?.text).toBe('Reviewed: "Yes, it is great."')
  expect(await ui.find({ type: 'Text', text: /newer response/ })).toBeUndefined()
  await ui.unmount()
})

test('a later answer marks the review as out of date', async ($, on) => {
  stubModels(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  await $.turn.complete({ ...TURN, turnId: 't2', answer: 'Something else.' })

  expect(await ui.find({ type: 'Text', text: /newer response/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent turn does not mark the review out of date', async ($, on) => {
  stubModels(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  await $.turn.complete({ ...TURN, turnId: 't2', agentId: 'sub-1' })

  expect(await ui.find({ type: 'Text', text: /newer response/ })).toBeUndefined()
  await ui.unmount()
})

test('a fix names the reviewed response, not just the last one', async ($, on) => {
  stubModels(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })
  await ui.press({ key: 'fix-0' })

  expect(sent[0]).toContain('"Yes, it is great."')
  expect(sent[0]).not.toContain('your last response')
  await ui.unmount()
})

const WITH_NUDGE = JSON.stringify({
  verdict: 'Mixed',
  summary: 'Leans on flattery.',
  strengths: ['Clear'],
  nudges: [{ flaw: 'Calls your plan great before weighing it', fix: 'Lead with the trade-offs' }],
  flaws: [{ flaw: 'Skips the cost', fix: 'Add the cost' }],
})

test('nudges get their own section, apart from flaws', async ($, on) => {
  stubModels(on, WITH_NUDGE)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(await ui.find({ type: 'Text', text: /^Nudging$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Calls your plan great/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Skips the cost/ })).toBeDefined()
  await ui.unmount()
})

test('a nudge has its own fix button', async ($, on) => {
  stubModels(on, WITH_NUDGE)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })
  await ui.press({ key: 'nudge-0' })

  expect(sent[0]).toContain('Lead with the trade-offs')
  await ui.unmount()
})

test('the reviewer is asked for nudges separately', async ($, on) => {
  const asked: string[] = []
  stubModels(on, REVIEW, EXCHANGE, asked)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(asked[0]).toContain('"nudges"')
  await ui.unmount()
})

test('a review with no nudges says none were found', async ($, on) => {
  stubModels(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })
  expect(await ui.find({ type: 'Text', text: /No nudging found/ })).toBeDefined()
  await ui.unmount()
})

const START = { text: 'Is my plan good?', turnId: 't1' }

test('the ask is the prompt the turn started with, not a hidden user row', async ($, on) => {
  const asked: string[] = []
  stubModels(
    on,
    REVIEW,
    [
      { role: 'user', text: 'Is my plan good?', toolUses: [] },
      { role: 'user', text: '<hidden command context>', toolUses: [] },
      { role: 'assistant', text: 'Yes, it is great.', toolUses: [] },
    ],
    asked,
  )
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.start(START)
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(asked[0]).toContain('USER REQUEST:\nIs my plan good?\n')
  await ui.unmount()
})

test('a subagent turn does not replace the ask', async ($, on) => {
  const asked: string[] = []
  stubModels(on, REVIEW, EXCHANGE, asked)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'Real ask', turnId: 't1' })
  await $.turn.start({ text: 'Subagent brief', turnId: 's1', agentId: 'sub-1' })
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(asked.at(-1)).toContain('USER REQUEST:\nReal ask\n')
  await ui.unmount()
})

test('Rerun during a turn waits and reviews when the turn ends', async ($, on) => {
  const calls = stubModels(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.turn.start(START)
  await ui.press({ key: 'rerun' })
  expect(calls).toEqual([])
  expect(await ui.find({ type: 'Text', text: /when this turn finishes/ })).toBeDefined()

  await $.turn.complete(TURN)
  await settle(ui)
  expect(calls).toHaveLength(1)
  await ui.unmount()
})

test('an answer that lands during a review gets its own review after', async ($, on) => {
  let release: () => void = () => {}
  let count = 0
  on('session.messages', () => ({ value: EXCHANGE }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.complete', async () => {
    count++
    if (count === 1) await new Promise<void>(r => (release = r))
    return { value: { isAnswered: true as const, text: REVIEW, usage: USAGE } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'auto' })

  const first = ui.press({ key: 'rerun' })
  await wait(10)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  release()
  await first
  for (let i = 0; i < 50 && count < 2; i++) await wait(5)

  expect(count).toBe(2)
  await ui.unmount()
})

test('/critique output is for the person only, not the model', async ($, on) => {
  stubModels(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ran = await $.command.run({
    command: 'critique',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(ran.isTextDisplayOnly).toBe(true)

  // Let the review /critique started finish before the test ends.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await settle(ui)
  await ui.unmount()
})

test('an answer split across several assistant messages is reviewed whole', async ($, on) => {
  const asked: string[] = []
  stubModels(
    on,
    REVIEW,
    [
      { role: 'user', text: 'Do it', toolUses: [] },
      { role: 'assistant', text: 'First part.', toolUses: [] },
      { role: 'user', text: '', toolUses: [] },
      { role: 'assistant', text: 'Second part.', toolUses: [] },
    ],
    asked,
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(asked[0]).toContain('ASSISTANT RESPONSE:\nFirst part.\n\nSecond part.')
  await ui.unmount()
})

test('lists that are not lists become empty, and bad items are made text', async ($, on) => {
  stubModels(
    on,
    JSON.stringify({ verdict: 'Weak', summary: 'x', strengths: 'not a list', nudges: {}, flaws: [{ flaw: 7 }] }),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rerun' })

  expect(await ui.find({ type: 'Text', text: /None listed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No nudging found/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^- 7$/ }))?.text).toBe('- 7')
  await ui.unmount()
})
