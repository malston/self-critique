export type Flaw = { flaw: string; fix: string }
export type Critique = {
  verdict: 'Strong' | 'Mixed' | 'Weak'
  summary: string
  strengths: string[]
  flaws: Flaw[]
}
export type Status = { phase: 'idle' | 'running' | 'error'; message?: string }

declare module 'claude-code' {
  interface PluginState {
    'self-critique': {
      review: Shaped<Critique | null>
      status: Shaped<Status>
      auto: Shaped<boolean>
      model: Shaped<string>
    }
  }
}
