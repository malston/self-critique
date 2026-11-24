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

test('rerun on a picked model draws the review, and a fix sends a prompt', async ($, on) => {
  const asked: string[] = []
  const sent: string[] = []
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Is my plan good?', toolUses: [] },
      { role: 'assistant', text: 'Yes, it is great.', toolUses: [] },
    ],
  }))
  on('model.complete', (_, e) => {
    asked.push(`${e.model}|${e.prompt}`)
    return { value: { isAnswered: true, text: `Here: ${REVIEW}`, usage: USAGE } }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.select({ key: 'model', value: 'haiku' })
  await ui.press({ key: 'rerun' })

  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatch(/^haiku\|/)
  expect(asked[0]).toContain('Yes, it is great.')
  expect((await ui.find({ type: 'Text', text: /Verdict/ }))?.text).toBe('Verdict: Mixed')
  expect(await ui.find({ type: 'Text', text: /Clear steps/ })).toBeDefined()

  await ui.press({ key: 'fix-0' })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Cite a source or hedge')
  await ui.unmount()
})

test('a reply that is not JSON shows an error, not a review', async ($, on) => {
  on('session.messages', () => ({
    value: [{ role: 'assistant', text: 'Hi', toolUses: [] }],
  }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'no json here', usage: USAGE } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'model', value: 'sonnet' })
  await ui.press({ key: 'rerun' })

  expect(await ui.find({ type: 'Text', text: /valid JSON/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Verdict/ })).toBeUndefined()
  await ui.unmount()
})

test('finds the user request behind many tool-only rows', async ($, on) => {
  const asked: string[] = []
  const toolRows = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 ? ('user' as const) : ('assistant' as const),
    text: '',
    toolUses: [],
  }))
  const rows = [
    { role: 'user' as const, text: 'Build the mod', toolUses: [] },
    ...toolRows,
    { role: 'assistant' as const, text: 'Done.', toolUses: [] },
  ]
  // Honors `last` as the engine does.
  on('session.messages', (_, e) => ({
    value: e.last === undefined ? rows : rows.slice(-e.last),
  }))
  on('model.complete', (_, e) => {
    asked.push(e.prompt)
    return { value: { isAnswered: true, text: REVIEW, usage: USAGE } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.select({ key: 'model', value: 'haiku' })
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
