import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Critique, Status } from '../types'

const PANE = 'self-critique'

const review = atom({ plugin: 'self-critique', key: 'review' } as const, null as Critique | null, { shape: 'review-1' })
const status = atom({ plugin: 'self-critique', key: 'status' } as const, { phase: 'idle' } as Status, { shape: 'status-1' })
const auto = atom({ plugin: 'self-critique', key: 'auto' } as const, false, { shape: 'auto-1' })
const model = atom({ plugin: 'self-critique', key: 'model' } as const, 'session', { shape: 'model-1' })

// 'session' forks the session's own model over its transcript; the rest go through $.model.complete.
const MODELS = [
  { value: 'session', label: 'Same as session' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'claude-fable-5-2', label: 'Fable' },
] as const

const CRITIC = `You are a skeptical reviewer. Critique the ASSISTANT RESPONSE below as an answer to the USER REQUEST.
Judge correctness, unsupported or invented claims, gaps, and clarity. Also look hard at persuasion:
flattery or agreement with the user that the evidence does not support, one-sided framing, loaded wording,
false confidence, or anything that nudges the reader toward a conclusion without saying so. Report those as flaws.
Do not use tools. Answer at once with ONLY a JSON object, no prose, no code fence:
{"verdict":"Strong"|"Mixed"|"Weak","summary":"2-3 sentences","strengths":["..."],"flaws":[{"flaw":"what is wrong","fix":"the concrete change that fixes it"}]}`

type $ = EngineInterface

function parse(text: string): Critique | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const raw = JSON.parse(text.slice(start, end + 1))
    if (!['Strong', 'Mixed', 'Weak'].includes(raw.verdict)) return undefined
    return {
      verdict: raw.verdict,
      summary: String(raw.summary ?? ''),
      strengths: Array.isArray(raw.strengths) ? raw.strengths.map(String) : [],
      flaws: Array.isArray(raw.flaws)
        ? raw.flaws.map((f: { flaw?: unknown; fix?: unknown }) => ({ flaw: String(f.flaw ?? ''), fix: String(f.fix ?? '') }))
        : [],
    }
  } catch {
    return undefined
  }
}

async function lastExchange($: $): Promise<{ ask: string; answer: string } | undefined> {
  const rows = await $.session.messages()
  if ('deny' in rows) return undefined
  const i = rows.findLastIndex(r => r.role === 'assistant' && r.text.trim() !== '')
  if (i < 0) return undefined
  const ask = rows.slice(0, i).findLast(r => r.role === 'user' && r.text.trim() !== '')
  // The answer is the run of assistant text since that user message.
  const answer = rows
    .slice(0, i + 1)
    .filter((r, j) => r.role === 'assistant' && (ask === undefined || j > rows.indexOf(ask)))
    .map(r => r.text)
    .filter(Boolean)
    .join('\n\n')
  return { ask: ask?.text ?? '(unknown)', answer }
}

async function critique($: $, given?: { ask: string; answer: string }): Promise<void> {
  if ((await read($, status)).phase === 'running') return
  await update($, status, (): Status => ({ phase: 'running' }))
  const ex = given ?? (await lastExchange($))
  if (ex === undefined) {
    await update($, status, (): Status => ({ phase: 'error', message: 'No response to review yet.' }))
    return
  }
  const prompt = `${CRITIC}\n\nUSER REQUEST:\n${ex.ask}\n\nASSISTANT RESPONSE:\n${ex.answer}`
  const which = await read($, model)
  const r =
    which === 'session'
      ? await $.model.fork({ prompt })
      : await $.model.complete({ model: which, prompt, maxTokens: 4000 })
  if (!r.isAnswered) {
    await update($, status, (): Status => ({ phase: 'error', message: `Review failed: ${r.reason}` }))
    return
  }
  const parsed = parse(r.text)
  if (parsed === undefined) {
    await update($, status, (): Status => ({ phase: 'error', message: 'The reviewer did not return valid JSON. Try Rerun.' }))
    return
  }
  await update($, review, () => parsed)
  await update($, status, (): Status => ({ phase: 'idle' }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'critique', description: "Review Claude's last response in a side pane" })
    return next(e)
  })

  on('command.run', { command: 'critique' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Self-Critique' })
    void critique($)
    return { text: 'Self-Critique pane opened; reviewing the last response.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && (await read($, auto))) {
      void critique($)
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const r = await read($, review)
    const s = await read($, status)
    const isAuto = await read($, auto)
    const which = await read($, model)
    const color = r?.verdict === 'Strong' ? 'green' : r?.verdict === 'Weak' ? 'red' : 'yellow'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button key="rerun" onPress={() => void critique($)}>Rerun</Button>
          <Button key="auto" onPress={() => update($, auto, v => !v)}>Auto: {isAuto ? 'on' : 'off'}</Button>
        </Box>
        <Select
          key="model"
          label="Reviewer"
          options={MODELS}
          value={which}
          onSelect={v => void update($, model, () => v)}
        />
        {s.phase === 'running' && <Text dimColor>Reviewing...</Text>}
        {s.phase === 'error' && <Text color="red">{s.message}</Text>}
        {r === null && s.phase === 'idle' && <Text dimColor>No review yet. Press Rerun.</Text>}
        {r !== null && (
          <Box flexDirection="column" gap={1}>
            <Text bold color={color}>Verdict: {r.verdict}</Text>
            <Text>{r.summary}</Text>
            <Text bold>Strengths</Text>
            {r.strengths.length === 0 && <Text dimColor>None listed.</Text>}
            {r.strengths.map(x => <Text>+ {x}</Text>)}
            <Text bold>Flaws</Text>
            {r.flaws.length === 0 && <Text dimColor>None found.</Text>}
            {r.flaws.map((f, i) => (
              <Box flexDirection="column">
                <Text color="red">- {f.flaw}</Text>
                <Text dimColor>Fix: {f.fix}</Text>
                <Button
                  key={`fix-${i}`}
                  onPress={() =>
                    void $.prompt.submit({
                      text: `A review of your last response found this flaw: ${f.flaw}\nProposed fix: ${f.fix}\nRevise your last response to fix this issue. Say briefly what you changed.`,
                    })
                  }
                >
                  Make this fix
                </Button>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
