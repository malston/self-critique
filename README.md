# Self-Critique

A Claude Code mod. Type `/critique` and a side pane reviews Claude's last response:

- a verdict: Strong, Mixed or Weak
- a short summary
- strengths
- flaws, each with a proposed fix and a **Make this fix** button that asks Claude to fix it

The reviewer is told to flag persuasion too: flattery, agreement the evidence doesn't support, one-sided framing and false confidence.

Controls: **Rerun**, **Auto** (review every answer), and a **Reviewer** model picker (Same as session, Opus, Sonnet, Haiku, Fable). A model other than the session's gives a more independent read. Every review is a model call billed to your session.

## Install

At the prompt of a terminal session:

```
/plugin install self-critique --marketplace malston/self-critique
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install self-critique --marketplace malston/self-critique
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `malston/self-critique`, then Add plugin.
