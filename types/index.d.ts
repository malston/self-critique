export type Verdict = 'Strong' | 'Mixed' | 'Weak'
export type Flaw = { flaw: string; fix: string }
export type Critique = {
  verdict: Verdict
  summary: string
  strengths: string[]
  /** Ways the response steers the reader without saying so. */
  nudges: Flaw[]
  flaws: Flaw[]
}
/** A critique plus which response it covers. */
export type Review = Critique & {
  /** The reviewed response's text. */
  answer: string
  /** The count of main-thread answers when the review started; a higher count means it is out of date. */
  atTurn: number
}
/** Only an error carries a message. */
export type Status = { phase: 'idle' | 'running' | 'waiting' } | { phase: 'error'; message: string }
/** A reviewer the picker offers: 'session' is the session's own model. */
export type Reviewer = 'session' | 'opus' | 'sonnet' | 'haiku' | 'claude-fable-5-2'

declare module 'claude-code' {
  interface PluginState {
    'self-critique': {
      review: Shaped<Review | null>
      status: Shaped<Status>
      auto: Shaped<boolean>
      model: Shaped<Reviewer>
      turns: Shaped<number>
      ask: Shaped<string | null>
      isTurnRunning: Shaped<boolean>
      isPending: Shaped<boolean>
    }
  }
}
