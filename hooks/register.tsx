import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Critique, Flaw, Review, Reviewer, Status, Verdict } from '../types'

const PANE = 'self-critique'

// Each atom spells out 'self-critique': the engine's state scan accepts only literal plugin and key names.

const review = atom({ plugin: 'self-critique', key: 'review' } as const, null as Review | null, { shape: 'review-3' })
const status = atom({ plugin: 'self-critique', key: 'status' } as const, { phase: 'idle' } as Status, { shape: 'status-2' })
const isAutoOn = atom({ plugin: 'self-critique', key: 'auto' } as const, false, { shape: 'auto-1' })
// Main-thread answers seen, so a review knows when a newer one has come.
const turns = atom({ plugin: 'self-critique', key: 'turns' } as const, 0, { shape: 'turns-1' })
// The prompt the last main-thread turn started with: the user's real request.
const ask = atom({ plugin: 'self-critique', key: 'ask' } as const, null as string | null, { shape: 'ask-1' })
const isTurnRunning = atom({ plugin: 'self-critique', key: 'isTurnRunning' } as const, false, { shape: 'running-1' })
// A review asked for while a turn or another review ran, to start once they end.
const isPending = atom({ plugin: 'self-critique', key: 'isPending' } as const, false, { shape: 'pending-1' })
const reviewer = atom({ plugin: 'self-critique', key: 'model' } as const, 'session' as Reviewer, { shape: 'model-1' })

// 'session' is the session's own model; every reviewer sees only the request and the response, not the conversation.
const REVIEWERS: readonly { value: Reviewer; label: string }[] = [
  { value: 'session', label: 'Same as session' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'claude-fable-5-2', label: 'Fable' },
]

// The verdicts, each with the color the pane draws it in.
const VERDICT_COLORS: Record<Verdict, 'green' | 'yellow' | 'red'> = { Strong: 'green', Mixed: 'yellow', Weak: 'red' }
const VERDICTS = Object.keys(VERDICT_COLORS) as Verdict[]

const CRITIC = `You are a skeptical reviewer. Critique the ASSISTANT RESPONSE below as an answer to the USER REQUEST.
Report two kinds of problem separately.
"nudges": ways the response steers the reader toward a conclusion without saying so: flattery, agreeing with
the user where the evidence does not support it, one-sided framing, left-out counterarguments, loaded wording,
false confidence. Look hard for these; an empty list is a claim that there are none.
"flaws": everything else: wrong or unsupported claims, gaps, unclear writing.
Do not use tools. Answer at once with ONLY a JSON object, no prose, no code fence:
{"verdict":${VERDICTS.map(v => `"${v}"`).join('|')},"summary":"2-3 sentences","strengths":["..."],"nudges":[{"flaw":"how it steers","fix":"the concrete change that removes it"}],"flaws":[{"flaw":"what is wrong","fix":"the concrete change that fixes it"}]}`

/** The request a response answered, and the response. */
type Exchange = { ask: string; answer: string }

const setStatus = ($: EngineInterface, next: Status) => update($, status, () => next)

/** The start of a response on one line, to name it. */
function opening(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}...` : line
}

function toFlaws(list: unknown): Flaw[] {
  if (!Array.isArray(list)) return []
  return list.map((f: { flaw?: unknown; fix?: unknown }) => ({ flaw: String(f.flaw ?? ''), fix: String(f.fix ?? '') }))
}

function parse(text: string): Critique | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const raw = JSON.parse(text.slice(start, end + 1))
    if (!VERDICTS.includes(raw.verdict)) return undefined
    return {
      verdict: raw.verdict,
      summary: String(raw.summary ?? ''),
      strengths: Array.isArray(raw.strengths) ? raw.strengths.map(String) : [],
      nudges: toFlaws(raw.nudges),
      flaws: toFlaws(raw.flaws),
    }
  } catch {
    return undefined
  }
}

async function lastExchange($: EngineInterface): Promise<Exchange | undefined> {
  const rows = await $.session.messages()
  if ('deny' in rows) return undefined
  const lastAnswer = rows.findLastIndex(row => row.role === 'assistant' && row.text.trim() !== '')
  if (lastAnswer < 0) return undefined
  const asked = rows.slice(0, lastAnswer).findLastIndex(row => row.role === 'user' && row.text.trim() !== '')
  // The answer is the run of assistant text since that user message.
  const answer = rows
    .slice(asked + 1, lastAnswer + 1)
    .filter(row => row.role === 'assistant' && row.text !== '')
    .map(row => row.text)
    .join('\n\n')
  const recorded = await read($, ask)
  return { ask: recorded ?? rows[asked]?.text ?? '(unknown)', answer }
}

async function critique($: EngineInterface, given?: Exchange): Promise<void> {
  if (await read($, isTurnRunning)) {
    // The answer is still being written; review it once the turn ends.
    await update($, isPending, () => true)
    await setStatus($, { phase: 'waiting' })
    return
  }
  if ((await read($, status)).phase === 'running') return
  try {
    await runReview($, given)
  } finally {
    if (await read($, isPending)) {
      await update($, isPending, () => false)
      void critique($)
    }
  }
}

async function runReview($: EngineInterface, given?: Exchange): Promise<void> {
  const fail = async (message: string): Promise<void> => {
    await setStatus($, { phase: 'error', message })
  }
  await setStatus($, { phase: 'running' })
  const atTurn = await read($, turns)
  const exchange = given ?? (await lastExchange($))
  if (exchange === undefined) return fail('No response to review yet.')
  const prompt = `${CRITIC}\n\nUSER REQUEST:\n${exchange.ask}\n\nASSISTANT RESPONSE:\n${exchange.answer}`
  const picked = await read($, reviewer)
  const modelName = picked === 'session' ? await $.session.model() : picked
  const reply = await $.model.complete({ model: modelName, prompt, maxTokens: 4000 })
  if (!reply.isAnswered) return fail(`Review failed: ${reply.reason}`)
  const critique = parse(reply.text)
  if (critique === undefined) return fail('The reviewer did not return valid JSON. Try Rerun.')
  await update($, review, () => ({ ...critique, answer: exchange.answer, atTurn }))
  await setStatus($, { phase: 'idle' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'critique', description: "Review Claude's last response in a side pane" })
    return next(e)
  })

  on('command.run', { command: 'critique' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Self-Critique' })
    void critique($)
    return { text: 'Self-Critique pane opened; reviewing the last response.', isTextDisplayOnly: true }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isTurnRunning, () => true)
      if (e.text.trim() !== '') await update($, ask, () => e.text)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    await update($, isTurnRunning, () => false)
    const isAnswer = e.reason === 'answer'
    if (isAnswer) await update($, turns, n => n + 1)
    const wanted = (await read($, isPending)) || (isAnswer && (await read($, isAutoOn)))
    if (!wanted) return done
    if ((await read($, status)).phase === 'running') {
      // Review this answer too once the running review ends.
      await update($, isPending, () => true)
    } else {
      await update($, isPending, () => false)
      void critique($)
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const shown = await read($, review)
    const current = await read($, status)
    const isAuto = await read($, isAutoOn)
    const picked = await read($, reviewer)
    const isStale = shown !== null && (await read($, turns)) > shown.atTurn
    // One row per problem, each with its fix and a button that asks Claude to make it.
    const issues = (reviewed: Review, list: Flaw[], key: string, tint: 'red' | 'yellow') =>
      list.map((f, i) => (
        <Box flexDirection="column">
          <Text color={tint}>- {f.flaw}</Text>
          <Text dimColor>Fix: {f.fix}</Text>
          <Button
            key={`${key}-${i}`}
            onPress={() =>
              void $.prompt.submit({
                text: `A review of your earlier response that begins "${opening(reviewed.answer, 300)}" found this problem: ${f.flaw}\nProposed fix: ${f.fix}\nRevise that response to fix this issue. Say briefly what you changed.`,
              })
            }
          >
            Make this fix
          </Button>
        </Box>
      ))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button key="rerun" onPress={() => void critique($)}>Rerun</Button>
          <Button key="auto" onPress={() => update($, isAutoOn, wasOn => !wasOn)}>Auto: {isAuto ? 'on' : 'off'}</Button>
        </Box>
        <Select
          key="model"
          label="Reviewer"
          options={REVIEWERS}
          value={picked}
          onSelect={value => {
            const choice = REVIEWERS.find(option => option.value === value)
            if (choice !== undefined) void update($, reviewer, () => choice.value)
          }}
        />
        {current.phase === 'running' && <Text dimColor>Reviewing...</Text>}
        {current.phase === 'waiting' && <Text dimColor>Will review when this turn finishes.</Text>}
        {current.phase === 'error' && <Text color="red">{current.message}</Text>}
        {shown === null && current.phase === 'idle' && <Text dimColor>No review yet. Press Rerun.</Text>}
        {shown !== null && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>Reviewed: "{opening(shown.answer, 80)}"</Text>
            {isStale && <Text color="yellow">A newer response has come since this review. Press Rerun to review it.</Text>}
            <Text bold color={VERDICT_COLORS[shown.verdict]}>Verdict: {shown.verdict}</Text>
            <Text>{shown.summary}</Text>
            <Text bold>Strengths</Text>
            {shown.strengths.length === 0 && <Text dimColor>None listed.</Text>}
            {shown.strengths.map(strength => <Text>+ {strength}</Text>)}
            <Text bold>Nudging</Text>
            {shown.nudges.length === 0 && <Text dimColor>No nudging found.</Text>}
            {issues(shown, shown.nudges, 'nudge', 'yellow')}
            <Text bold>Flaws</Text>
            {shown.flaws.length === 0 && <Text dimColor>None found.</Text>}
            {issues(shown, shown.flaws, 'fix', 'red')}
          </Box>
        )}
      </Box>
    )
  })
}
