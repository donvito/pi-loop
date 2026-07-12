# Changelog

## 1.0.0

- Initial public release of `@realvendex/pi-loop`.
- `/loop` command mirroring Claude Code's loop behavior with Pi-specific enhancements.
- Stop conditions: `--until` (text), `--until-regex`, `--until-all`, `--until-stable`,
  `--until-stable-sim` (fuzzy), `--until-converged` (single-step similarity threshold).
- Robustness: per-iteration `--iter-timeout`, wall-clock `--timeout`, error markers,
  `--stop-on-error`, `--retry-on-error` with exponential backoff, `--max-failures`,
  and a bounded default turn timeout so a stuck turn can never hang the loop forever.
- External verification: `--until-cmd` / `--until-cmd-fail` (run a shell command and
  stop on its exit status).
- Lifecycle hooks: `--on-start`, `--on-fail`, `--on-stop`, `--on-iter` with token
  substitution.
- Rich prompt templating: `{{n}} {{max}} {{prev}} {{prev:N}} {{last:N}} {{all}} {{count}} {{ts}}`.
- Rich live TUI panel: animated boxed status (spinner, progress, phase, ETA,
  convergence bar, last-reply preview) via Pi's widget renderer.
- Completion summary enriched with loop name + convergence percentage.
- `--notify` (OS toast) and `--sound` (terminal bell) on finish.
- Subcommands: `stop`, `resume`, `save`/`load`/`list`/`delete`, `last`, `logs`,
  `stats`, `show`, `preview`.
- JSON run logs written to `~/.pi/loops/` (last 20 retained).
