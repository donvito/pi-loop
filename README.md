# pi-loop

[![npm version](https://img.shields.io/npm/v/@realvendex/pi-loop.svg)](https://www.npmjs.com/package/@realvendex/pi-loop)
[![license](https://img.shields.io/npm/l/@realvendex/pi-loop.svg)](./LICENSE)
[![CI](https://github.com/ZachDreamZ/pi-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/ZachDreamZ/pi-loop/actions/workflows/ci.yml)

A [Pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension that adds a
**`/loop`** command — run a prompt repeatedly, confirming between rounds, exactly like the
Claude Code CLI `/loop`, but with a richer set of stop conditions, lifecycle hooks, a live
TUI panel, and desktop notifications.

```text
╭────────────────────────────────────────────╮
│ ⟳ /loop  iter 3/5                          │
│ ███████████████░░░░░ 60%                   │
│ ⠴ idle   12.3s                            │
│ tag    build                              │
│ conv   ████████░░ 82%                      │
│ ↳ refactored the loop panel for clarity    │
│ ⊘ /loop stop to cancel                     │
╰────────────────────────────────────────────╯
```

---

## Features

- **Repeat a prompt** with optional per-round confirmation (manual mode) or fully unattended (**YOLO** autopilot).
- **Stop conditions**: text match, regex match, all-match, identical-reply convergence, fuzzy convergence, single-step similarity threshold, external command success/failure, wall-clock timeout, per-iteration timeout, error markers, and max failures.
- **Self-referential prompts** via rich templating: `{{n}}`, `{{prev}}`, `{{prev:N}}`, `{{last:N}}`, `{{all}}`, `{{count}}`, `{{ts}}`.
- **Lifecycle hooks** (`--on-start` / `--on-fail` / `--on-stop` / `--on-iter`) to drive external automation (CI, notifications, logging).
- **Rich live TUI panel**: animated boxed status with progress bar, phase indicator, ETA, convergence bar, and a last-reply preview.
- **Resilience**: exponential-backoff retries on error markers, a bounded default turn timeout (so a stuck agent can never hang the loop forever), and a single-loop concurrency guard.
- **Run logs**: every loop writes a JSON log to `~/.pi/loops/` (last 20 kept); browse them with `logs`, `stats`, `show`.
- **Presets**: save/load named loop configs; `/loop` with no args resumes the last run.
- **Finish signals**: `--notify` (OS toast) and `--sound` (terminal bell).

---

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) installed and running.
- Node.js 18+ (Pi's runtime).

---

## Install

`@realvendex/pi-loop` is a Pi package: it ships a `pi` manifest that tells Pi to load `index.ts` as an extension. Pick **one** method — do **not** combine them, or `/loop` gets registered twice and Pi warns about a duplicate command.

### Option A — `pi install` (recommended)

```bash
pi install npm:@realvendex/pi-loop          # latest
pi install npm:@realvendex/pi-loop@1.0.1    # or pin a version
```

Pi installs the package under `~/.pi/agent/npm/` and auto-loads the extension from its `pi` manifest. Run `/reload` (or restart Pi) to activate it. Update later with `pi update npm:@realvendex/pi-loop`.

### Option B — git clone

```bash
git clone https://github.com/ZachDreamZ/pi-loop /tmp/pi-loop
cp /tmp/pi-loop/extensions/index.ts ~/.pi/agent/extensions/pi-loop/index.ts
```

Then run `/reload` (or restart Pi). No build step — Pi loads `index.ts` directly from the extensions directory.

### Option C — npm + manual copy

```bash
npm i -g @realvendex/pi-loop
# copy the extension entry into Pi's extension directory
cp "$(npm root -g)/@realvendex/pi-loop/index.ts" ~/.pi/agent/extensions/pi-loop/index.ts
/reload
```

> Local install works too: `npm i @realvendex/pi-loop` then copy `node_modules/@realvendex/pi-loop/index.ts` into the extensions directory.

---

## Quick start

```text
/loop "fix the failing tests" --max 5
/loop --yes --until "all tests pass" "refactor the auth module"
/loop "attempt {{n}}: {{prev}}" --max 5 --yes
/loop --yes --until-stable 3 "tweak until output converges"
/loop --until-converged 95 --max 20 "iterate until replies stop changing"
/loop --until-regex "tests:\s+\d+ passing" --yes "run the suite"
/loop --timeout 5m "long autonomous task"
/loop --name deploy --yes "ship it"        # tagged run log
/loop --notify --sound --yes --max 5 "do the work"   # toast + bell on finish
/loop                                      # resume the last loop
/loop stop                                 # cancel the active loop
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/loop "<prompt>" [flags]` | Run a loop (the main command). |
| `/loop stop` | Cancel the active loop (halts after the current iteration). |
| `/loop resume` | Re-run the last `/loop` invocation (also: bare `/loop`). |
| `/loop save NAME` | Save the last run's config as a named preset. |
| `/loop load NAME` | Run a saved preset (alias: `/loop run NAME`). |
| `/loop list` | List all saved presets and the last config. |
| `/loop delete NAME` | Delete a saved preset. |
| `/loop last` | Print the most recent loop config. |
| `/loop logs [TAG]` | List recent run logs (most recent first), optionally filtered by a `--name` tag. |
| `/loop stats` | Aggregate metrics across all run logs (count, avg iterations, avg duration, stop-reason breakdown). |
| `/loop show [N]` | View a run log. `N` = index (`1` = most recent), a filename, or a substring. |
| `/loop preview "<prompt> ...flags>"` | Print the resolved config and **every** templated prompt (up to 10) **without running** — great for debugging templates. |

---

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--max N` / `-n N` | `10` | Maximum iterations. `--max 0` = **unbounded** (runs until a stop condition, `--timeout`, or `/loop stop`). |
| `--until "TEXT"` | — | Stop when the last assistant reply contains `TEXT`. Repeatable (any match stops). |
| `--until-regex R` | — | Stop when the last assistant reply matches regex `R`. Repeatable. Invalid patterns are ignored with a warning. |
| `--until-all` / `--all` | off | Require **ALL** `--until` texts AND `--until-regex` patterns to match (default: ANY match stops). |
| `--until-stable N` | `0` | Stop when the last `N` consecutive replies are identical (convergence). |
| `--until-stable-sim P` / `--stable-sim P` | `0` | Fuzzy convergence: last `N` replies must be **≥P similar** (token-overlap, `0..1`) instead of byte-identical. |
| `--until-converged P` / `--converge P` | `0` | Stop when the **single-step** similarity between the last two replies is **≥ P%** (0–100). Distinct from `--until-stable-sim`, which requires a window of `N` replies. |
| `--yes` / `-y` / `--auto` / `--yolo` | off | **YOLO autopilot**: skip per-round confirmation *and* auto-approve any confirmation surfaced during a turn. Never blocks. |
| `--delay MS` / `--every MS` | `0` | Milliseconds to wait between iterations. |
| `--delay-jitter P` | `0` | Apply **±P%** random jitter to `--delay` (`0..100`) to avoid rate-limit clumping. |
| `--timeout 30s\|5m\|1h` | `0` | Wall-clock cap; loop stops when exceeded (units `s`/`m`/`h`, or bare seconds). |
| `--iter-timeout 30s\|5m\|1h` | `0` | Per-iteration cap; if a single turn exceeds it, the loop stops. When unset, a **30-minute default bound** still applies so a stuck turn can't hang the loop forever. |
| `--stop-on-error` | off | Stop if the last assistant reply shows an error marker. |
| `--retry-on-error N` / `--retry N` | `0` | Retry a failed iteration up to `N` times (nudges the agent to try a different approach) before stopping. |
| `--retry-delay MS` | `1000` | Base delay between retries; grows exponentially (`MS`, `2·MS`, `4·MS` … capped at 60s). |
| `--max-failures N` | `0` | Stop after `N` consecutive failed iterations (error marker with no retry left, and `--stop-on-error` not set). |
| `--until-cmd C` / `--until-command C` | — | Stop when shell command `C` exits 0 (e.g. run your test suite; loop until it passes). Checked once before iteration 1 and after every iteration; 120s timeout (override with `--until-cmd-timeout`). |
| `--until-cmd-fail C` / `--until-command-fail C` | — | Inverse: stop when shell command `C` exits **non-zero** (e.g. loop while a server is up; stop the moment it goes down). |
| `--until-cmd-timeout T` | `120s` | Timeout for `--until-cmd` / `--until-cmd-fail` (units `s`/`m`/`h`, or bare ms). |
| `--on-start CMD` | — | Run shell `CMD` once, just before iteration 1 (skipped if a pre-flight check already ends the loop). Tokens: `{{i}} {{max}} {{name}}`. |
| `--on-fail CMD` | — | Run shell `CMD` after each failed iteration. Tokens: `{{i}} {{reply}} {{reason}}`. |
| `--on-stop CMD` | — | Run shell `CMD` once when the loop ends (any reason). Tokens: `{{i}} {{reason}} {{iterations}} {{reply}}`. |
| `--on-iter CMD` | — | Run shell `CMD` after every **completed** iteration. Tokens: `{{i}} {{reply}} {{reason}}`. |
| `--hook-timeout T` | `30s` | Timeout for hook commands; a hung hook is killed and reported as a warning, never aborting the loop. |
| `--error-markers A\|B` | built-ins | Custom pipe-delimited error markers (overrides the built-in list). |
| `--name TAG` | — | Tag the run-log filename (e.g. `loop-deploy-<ts>.json`) for easy lookup. |
| `--quiet` / `-q` | off | Suppress per-iteration start notices. |
| `--notify` | off | Show an OS notification (macOS / Linux / Windows) when the loop finishes. |
| `--sound` | off | Play a terminal bell when the loop finishes. |

---

## Prompt templating

Before each send, these tokens are substituted into the prompt (unknown tokens are left untouched):

| Token | Substituted with |
|-------|------------------|
| `{{n}}` / `{{N}}` / `{{i}}` | 1-based iteration number |
| `{{max}}` / `{{MAX}}` | Total iteration cap, or `∞` when `--max 0` (unbounded) |
| `{{prev}}` / `{{prev1}}` | The previous assistant reply (whitespace collapsed, truncated to 500 chars) |
| `{{prev:N}}` | The Nth-previous reply (`2` = the one before `{{prev}}`) |
| `{{last:N}}` | The last `N` characters of the previous reply |
| `{{all}}` | All prior replies joined by `---` |
| `{{count}}` | Number of completed prior iterations |
| `{{ts}}` | Current timestamp at render time (ISO 8601, fresh per iteration) |

Example — each iteration builds on everything that came before:

```text
/loop --yes --max 8 "Iteration {{n}} of {{max}} ({{count}} prior attempts).\nPrior work:\n{{all}}\nNow improve it."
```

---

## Lifecycle hooks

Hooks let a loop drive external automation at key moments. Each hook is a shell command;
Pi substitutes `{{token}}` vars before running it and reports the output via a notification.
A hook that errors or times out is reported as a **warning** and never stops the loop.

| Hook | When it fires | Available tokens |
|------|--------------|------------------|
| `--on-start CMD` | Once, before iteration 1 (only if the loop actually runs) | `{{i}}` (=0), `{{max}}`, `{{name}}`, `{{reason}}` |
| `--on-fail CMD` | After each failed iteration (error marker, no retry remaining) | `{{i}}`, `{{n}}`, `{{max}}`, `{{name}}`, `{{reason}}` (=`error-marker`), `{{reply}}`, `{{prev}}` |
| `--on-stop CMD` | Once, when the loop ends (any reason) | `{{i}}`, `{{n}}`, `{{max}}`, `{{name}}`, `{{reason}}` (stop cause), `{{iterations}}`, `{{reply}}`, `{{prev}}` |
| `--on-iter CMD` | After every completed iteration (next-iteration path) | `{{i}}`, `{{n}}`, `{{max}}`, `{{name}}`, `{{reason}}` (=`iteration`), `{{reply}}`, `{{prev}}` |

Shared hook tokens: `{{i}}`/`{{n}}` (iteration), `{{max}}` (cap or `∞`), `{{name}}` (tag),
`{{reason}}` (stop cause: `max`, `until`, `error`, `timeout`, `cmdfail`, `maxfailures`,
`stable`, `converged`, …), `{{reply}}` (latest reply), `{{prev}}` (prior reply),
`{{iterations}}` (total run). Control hook runtime with `--hook-timeout` (default `30s`).

```text
/loop --yes --max 5 --on-stop "curl -s ntfy.sh/mytopic -d 'loop done: {{reason}}'" "build the thing"
/loop --yes --until-cmd "npm test" --on-fail "echo 'FAILED iter {{i}}: {{reply}}' >> /tmp/loop-fails.log" "fix the tests"
/loop --yes --max 3 --on-start "echo loop started for {{name}}" --name nightly "run the job"
```

---

## Behavior

- **Manual mode** (default): after each iteration Pi asks you to continue. Decline (or press Escape) to stop.
- **Autopilot mode** (`--yes` / `--auto` / `--yolo`): runs unattended and auto-approves *every* prompt. Still stops on `--max`, `--timeout`, `--iter-timeout`, a `--until` match, convergence, or an error marker when `--stop-on-error` is set.
- **Cancel anytime**: send `/loop stop`. The loop halts after the current iteration completes (it never kills a turn mid-flight).
- A rich **live TUI panel** shows the current iteration, progress, phase, ETA, convergence, and last-reply snippet. The final summary reports the stop reason, total time, average time per iteration, and convergence percentage.
- Every loop writes a **JSON run log** to `~/.pi/loops/` (last 20 kept).

---

## Notes

- Only one loop runs at a time. Starting a new `/loop` while one is active is blocked until you send `/loop stop`.
- The loop sends real user messages via `pi.sendUserMessage`, so the agent behaves exactly as if you typed the prompt each round.
- In non-interactive contexts (no UI), manual confirmation is unavailable, so the loop automatically switches to autopilot with a warning.

---

## Development

```bash
git clone https://github.com/ZachDreamZ/pi-loop
cd pi-loop
npm install        # pulls typescript + @types/node for type-checking
npm run typecheck  # tsc --noEmit (validates the extension in isolation via a type shim)
```

`extensions/index.ts` is the entire extension. Pi loads it directly (no build step). The type shim in
`shims/pi-coding-agent.d.ts` lets `tsc` type-check the file without the Pi binary. CI runs
`npm run typecheck` on every push/PR.

---

## License

[MIT](./LICENSE) © ZachDreamZ
