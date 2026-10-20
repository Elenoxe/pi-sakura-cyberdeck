# Claude Shimmer Sakura (bundled)

Claude Code–style working spinner, recolored for sakura-macaron.

```text
✻ Whisking...  ( HIGH · ↓ ~1.2k tokens · ~48 tok/s · 00:12 )
```

- One verb per agent run (stable across tool rounds and retries), swept by a soft white highlight over sakura → sky
- Fixed-width `...` dots, so the HUD never shifts
- Status HUD: `( EFFORT · ↑/↓ N tokens · N tok/s · mm:ss )` with ` · ` separators
  - `↑` while waiting for the model, `↓` while it streams
  - Output tokens accumulate across the whole run; `~` marks a live estimate (the provider's final usage replaces it)
  - Speed uses the same sky color as tokens: estimated output tokens in the last 3 seconds / 3 seconds, including thinking and all tool arguments; during warm-up, divides by elapsed time since the first nonempty delta
  - Appears after one second of generation. Streaming stalls count in full: samples expire and speed reaches `~0 tok/s` after three seconds without output. Each assistant message starts a fresh window; the last reading freezes during tools and waits
  - Speed always carries `~`: final provider usage corrects the total token counter, not the sliding-window estimate, because it cannot identify which tokens fell inside the window
- Effort tiers: MINIMAL / LOW / MEDIUM / HIGH / XHIGH / MAX (tier colors); the tag glows while the model thinks
- Stall hint: after ~3s without stream updates the verb fades toward coral
- Tool hint: while a tool runs, the verb pulses toward mint
- Completion notice `✻ Baked for 12s · 48 tok/s` after successful runs only (nothing after Esc or errors); speed is total output tokens divided by whole-run elapsed time, including waits, tools and retries. `~` appears only when token totals contain estimates; speed is omitted for zero elapsed time.
- Interactive TUI only; one ~11 Hz clock while the agent works, no timers when idle

Fork of [pi-claude-shimmer](https://github.com/ouzhenkun/pi-claude-shimmer) (MIT).
