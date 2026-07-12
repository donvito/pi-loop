/**
 * pi-loop
 *
 * A Pi extension that adds a `/loop` command, mirroring the Claude Code CLI
 * `/loop` behavior: run a prompt repeatedly, confirming between rounds.
 *
 * Usage:
 *   /loop "fix the failing tests" --max 5
 *   /loop --yes --until "all tests pass" "refactor the auth module"
 *   /loop --yes --until-regex "tests:\s+\d+ passing" "run suite"
 *   /loop "attempt {{n}}: {{prev}}" --max 5 --yes      # prompt templating
 *   /loop "attempt {{n}} @ {{ts}}: {{prev}}" --max 5 --yes   # {{ts}} = current timestamp
 *   /loop --yes --until-stable 3 "tweak until stable"  # stop on convergence
 *   /loop --timeout 5m "long autonomous task"
 *   /loop --name deploy --yes "ship it"                # tag the run log
 *   /loop stop                                          # cancel the active loop
 *   /loop                                               # resume the last loop
 *
 *   /loop save myfix    # save the last run's config as a named preset
 *   /loop load myfix    # run a saved preset
 *   /loop resume        # re-run the last loop config
 *   /loop list          # list saved presets + last config
 *   /loop delete myfix  # delete a saved preset
 *   /loop logs [TAG]   # list recent run logs (optionally filter by --name tag)
 *   /loop stats         # aggregate metrics across all run logs (count, avg, stop reasons)
 *   /loop show [N]      # view a run log (N = 1 = most recent, or a filename)
 *   /loop preview "..." # show resolved config + every templated prompt (no run)
 *
 *   ─── Enhancement log ───
 *   R1: added {{ts}} timestamp token to prompt templating (ISO 8601, rendered per iteration)
 *   FIX: stall detection now uses content (getLastAssistantText) + 5s post-settle grace poll instead of entry-count comparison, which false-stalled on the entry-commit race (waitForIdle resolved before the reply was flushed).
 *   R2: rich TUI — animated, boxed live-status panel via ctx.ui.setWidget renderer (braille spinner, progress bar / indeterminate for ∞, phase, ETA, convergence, last-reply preview). Single guarded animation timer, cleared in finally (no interval leak).
 *   R3: polish pass — dropped redundant global working-indicator spinner (panel owns the animation); aligned label column; typed theme/tui/renderer interfaces; hardened renderer (try/catch so a render error can't crash the loop) + guarded show/hide helpers; richer completion summary (name + convergence); added --notify (OS toast) and --sound (terminal bell) flags.
 *   R4: added --until-converged P (stop when single-step similarity ≥ P%); richer prompt tokens {{prev:N}} {{last:N}} {{all}} {{count}}; bounded default turn timeout (30m) so a stuck turn can't hang the loop forever when --iter-timeout is unset.
 *
 * Flags:
 *   --max N            Maximum iterations (default 10). Use --max 0 for unbounded (loop until a stop condition, --timeout, or /loop stop).
 *   --until T          Stop when the last assistant message contains T. Repeatable.
 *   --until-regex R    Stop when the last assistant reply matches regex R. Repeatable.
 *   --until-all        Require ALL --until texts AND --until-regex patterns to match (default: ANY match stops)
 *   --until-stable N   Stop when the last N consecutive replies are identical.
 *   --until-converged P  Stop when single-step reply similarity ≥ P% (0-100).
 *   --yes / -y / --auto / --yolo   Autopilot (YOLO) — skip per-round confirmation AND auto-approve any confirmation surfaced during the loop (always-continue)
 *   --delay MS         Wait MS between iterations (alias: --every)
 *   --timeout 30s|5m   Wall-clock cap; loop stops when exceeded (units: s/m/h)
 *   --iter-timeout 30s|5m  Per-iteration cap; if a single turn exceeds it, the loop stops (units: s/m/h)
 *   --stop-on-error    Stop if the last assistant message shows an error marker
 *   --retry-on-error N Retry a failed iteration up to N times (nudges the agent to try a different approach) before stopping
 *   --retry-delay MS  Base delay between retries; grows exponentially (MS, 2*MS, 4*MS … capped at 60s)
 *   --max-failures N   Stop after N consecutive failed iterations (error marker with no retry left)
 *   --until-cmd C      Stop when shell command C exits 0 (e.g. run your test suite; loop until it passes)
 *   --until-cmd-fail C Stop when shell command C exits non-zero (inverse of --until-cmd)
 *   --until-cmd-timeout T  Timeout for --until-cmd (default 120s)
 *   --on-start CMD    Run shell CMD once before the first iteration (tokens: {{i}} {{max}} {{name}})
 *   --on-fail CMD     Run shell CMD after each failed iteration (tokens: {{i}} {{reply}} {{reason}})
 *   --on-stop CMD     Run shell CMD once when the loop ends (tokens: {{i}} {{reason}} {{iterations}})
 *   --hook-timeout T  Timeout for hook commands (default 30s)
 *   --until-stable-sim P  Convergence tolerance 0..1; last N replies must be ≥P similar (token overlap) instead of byte-identical
 *   --on-iter CMD     Run shell CMD after every completed iteration (tokens: {{i}} {{reply}} {{reason}})
 *   --delay-jitter P  Apply ±P% random jitter to --delay (0..100) to dither cadence
 *   --error-markers A|B Custom pipe-delimited error markers (overrides defaults)
 *   --name TAG         Tag the run-log filename for easy lookup
 *   --quiet            Suppress per-iteration start notices
 *   --notify           Show an OS notification when the loop finishes
 *   --sound            Play a terminal bell when the loop finishes
 *
 * Prompt templating tokens (substituted before each send):
 *   {{n}}/{{N}}/{{i}}   1-based iteration number
 *   {{max}}/{{MAX}}     max iterations (or ∞ if unbounded)
 *   {{prev}}/{{prev1}}  previous assistant reply (whitespace-collapsed, truncated)
 *   {{prev:N}}          Nth-previous reply (2 = the one before prev)
 *   {{last:N}}          last N characters of the previous reply
 *   {{all}}            all prior replies joined by '---'
 *   {{count}}          number of completed prior iterations
 *   {{ts}}             current ISO timestamp
 *
 * Send `/loop stop` at any time to cancel. Every loop writes a JSON run log to
 * ~/.pi/loops/ for later review.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec, execFileSync } from "node:child_process";

// ─── Constants ────────────────────────────────────────────────────────────

const LOOP_COMMAND = "loop";

const LOOP_COMMAND_DESCRIPTION =
	"Loop a prompt repeatedly (Claude Code-style). Flags: --max N (0 = unbounded), --until T, --until-regex R, --until-all, --until-stable N (--until-stable-sim P for fuzzy), --until-converged P (stop when single-step similarity ≥ P%), --yes/--auto/--yolo (YOLO: auto-approve all), --delay MS (--delay-jitter P), --timeout 30s|5m, --iter-timeout 30s|5m, --stop-on-error, --retry-on-error N, --retry-delay MS, --max-failures N, --until-cmd C, --until-cmd-fail C, --until-cmd-timeout T, --on-start/--on-fail/--on-iter/--on-stop CMD, --hook-timeout T, --error-markers, --name, --quiet. /loop stop cancels. Subcommands: resume, save/load/list/delete, logs [TAG], stats, show, preview. Prompt tokens: {{n}}/{{i}}/{{max}}/{{prev}}/{{prev:N}}/{{last:N}}/{{all}}/{{count}}/{{ts}}.";

const LOOP_USAGE =
	"Usage: /loop [--max N] [--until \"TEXT\"]... [--until-regex R]... [--until-stable N] [--until-converged P] [--yes] [--delay MS] [--timeout 30s|5m] [--iter-timeout 30s|5m] [--stop-on-error] [--error-markers A|B] [--name TAG] [--quiet] <prompt>\n" +
	"       /loop            (resume last)\n" +
	"       /loop stop | resume | save NAME | load NAME | list | delete NAME | last | logs [TAG] | show [N] | preview <prompt...>";

const DEFAULT_MAX_ITERATIONS = 10;
const TURN_START_GRACE_MS = 3000;
const POLL_INTERVAL_MS = 50;
const MAX_PREV_CHARS = 500;
const MAX_LOG_FILES = 20;
const PREVIEW_ITERATION_CAP = 10;
const CMD_DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_CAP_MS = 60_000;
// Extra wait after a turn settles, to absorb the entry-commit race:
// waitForIdle can resolve a tick before the assistant reply is flushed to the session.
const STALL_SETTLE_GRACE_MS = 5000;
// Nudge appended to the prompt on a retry so the agent takes a different approach.
const RETRY_NUDGE =
	"\n\n[loop] The previous attempt stopped on an error marker. Reassess the situation and try a different approach.";

// Default upper bound on a single turn when --iter-timeout is not set, so a stuck
// agent can never hang the loop forever (override with --iter-timeout).
const DEFAULT_TURN_TIMEOUT_MS = 1_800_000;

// Replace {{key}} tokens in a template with provided values. Unknown tokens are left untouched.
// Supported keys: n|N|i (iteration index), max|MAX (max iterations or ∞), prev (previous reply).
function substituteTokens(template: string, vars: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(vars)) {
		out = out.replaceAll(`{{${key}}}`, value);
	}
	return out;
}

// Token-overlap (Jaccard) similarity of two replies, used for fuzzy convergence.
// Punctuation and case are normalized so trailing punctuation/noise doesn't block a match.
function similarityRatio(a: string, b: string): number {
	const tokens = (s: string) =>
		new Set(
			s
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, " ")
				.split(/\s+/)
				.filter(Boolean),
		);
	const ta = tokens(a);
	const tb = tokens(b);
	if (ta.size === 0 && tb.size === 0) return 1;
	if (ta.size === 0 || tb.size === 0) return 0;
	let inter = 0;
	for (const w of ta) if (tb.has(w)) inter++;
	return inter / (ta.size + tb.size - inter);
}

// Default markers that, when present in the last assistant reply, indicate a failure.
const DEFAULT_ERROR_MARKERS = [
	"Error:",
	"ERROR:",
	"TypeError:",
	"ReferenceError:",
	"Traceback (most recent call last)",
	"✗",
	"❌",
	"command failed",
	"Build failed",
];

const LOOP_STATE_DIR = join(homedir(), ".pi");
const LOOP_STATE_FILE = join(LOOP_STATE_DIR, "loop-state.json");
const LOOP_LOG_DIR = join(LOOP_STATE_DIR, "loops");

// ─── State ────────────────────────────────────────────────────────────────

interface LoopController {
	active: boolean;
	stopRequested: boolean;
	iteration: number;
	requestStop(): void;
}

/** Only one loop may run at a time. Kept module-level so /loop stop can reach it. */
let activeLoop: LoopController | null = null;

// ─── Options ──────────────────────────────────────────────────────────────

interface LoopOptions {
	prompt: string;
	maxIterations: number;
	stopTexts: string[];
	stopRegexStrings: string[];
	autoPilot: boolean;
	delayMs: number;
	timeoutSeconds: number;
	iterTimeoutSeconds: number;
	stopOnError: boolean;
	retryOnError: number;
	retryDelayMs: number;
	untilCmdTimeoutMs: number;
	errorMarkers: string[];
	quiet: boolean;
	notify: boolean;
	sound: boolean;
	untilStable: number;
	untilAll: boolean;
	maxFailures: number;
	untilCmd: string;
	untilCmdFail: string;
	name: string;
	onStart: string;
	onFail: string;
	onStop: string;
	hookTimeoutMs: number;
	onIter: string;
	untilStableSim: number;
	untilConverged: number;
	delayJitterPct: number;
}

interface LoopState {
	last: LoopOptions | null;
	presets: Record<string, LoopOptions>;
}

interface LoopLogEntry {
	iteration: number;
	prompt: string;
	summary: string;
	durationMs: number;
}

type StopReason =
	| "max"
	| "until"
	| "user"
	| "error"
	| "timeout"
	| "itertimeout"
	| "stop"
	| "manual"
	| "stable"
	| "converged"
	| "stall"
	| "cmd"
	| "cmdfail"
	| "maxfailures"
	| "done";

// ─── Argument parsing ─────────────────────────────────────────────────────

/**
 * Split input into tokens, honoring single and double quotes.
 */
function tokenizeArguments(input: string): string[] {
	const tokens: string[] = [];
	const matcher = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;

	while ((match = matcher.exec(input)) !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	}

	return tokens;
}

/**
 * Parse a human-friendly duration like "30s", "5m", "1h", or a bare number
 * (interpreted as seconds) into total seconds.
 */
function parseDurationToSeconds(value: string): number {
	const trimmed = value.trim().toLowerCase();
	const matcher = /^(\d+(?:\.\d+)?)\s*([smh])?$/.exec(trimmed);
	if (!matcher) return 0;
	const amount = Number.parseFloat(matcher[1]);
	const unit = matcher[2] ?? "s";
	const factor = unit === "h" ? 3600 : unit === "m" ? 60 : 1;
	return Math.round(amount * factor);
}

/**
 * Parse `/loop` arguments into structured options. Flags are consumed with
 * their following value; everything else joins back into the prompt.
 */
function parseLoopArgs(input: string): LoopOptions {
	const tokens = tokenizeArguments(input);
	let maxIterations = DEFAULT_MAX_ITERATIONS;
	const stopTexts: string[] = [];
	const stopRegexStrings: string[] = [];
	let autoPilot = false;
	let delayMs = 0;
	let timeoutSeconds = 0;
	let iterTimeoutSeconds = 0;
	let stopOnError = false;
	let retryOnError = 0;
	let retryDelayMs = 1000;
	let untilCmdTimeoutMs = CMD_DEFAULT_TIMEOUT_MS;
	let untilCmd = "";
	let untilCmdFail = "";
	let onStart = "";
	let onFail = "";
	let onStop = "";
	let hookTimeoutMs = 30_000;
	let onIter = "";
	let untilStableSim = 0;
	let untilConverged = 0;
	let delayJitterPct = 0;
	let errorMarkers: string[] = [];
	let quiet = false;
	let untilStable = 0;
	let untilAll = false;
	let maxFailures = 0;
	let name = "";
	let notify = false;
	let sound = false;
	const promptTokens: string[] = [];

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];

		if (token === "--max" || token === "-n") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				const parsedMax = Number.parseInt(value, 10);
				maxIterations = Number.isNaN(parsedMax) ? DEFAULT_MAX_ITERATIONS : parsedMax;
				index++;
			}
		} else if (token === "--until") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				stopTexts.push(value);
				index++;
			}
		} else if (token === "--until-regex") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				stopRegexStrings.push(value);
				index++;
			}
		} else if (token === "--until-all" || token === "--all") {
			untilAll = true;
		} else if (token === "--until-stable") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				untilStable = Number.parseInt(value, 10) || 0;
				index++;
			}
		} else if (token === "--until-stable-sim" || token === "--stable-sim") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				untilStableSim = Math.min(1, Math.max(0, Number.parseFloat(value) || 0));
				index++;
			}
		} else if (token === "--until-converged" || token === "--converge") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				untilConverged = Math.min(100, Math.max(0, Number.parseInt(value, 10) || 0));
				index++;
			}
		} else if (token === "--delay" || token === "--every") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				delayMs = Number.parseInt(value, 10) || 0;
				index++;
			}
		} else if (token === "--delay-jitter") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				delayJitterPct = Math.min(100, Math.max(0, Number.parseInt(value, 10) || 0));
				index++;
			}
		} else if (token === "--timeout") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				timeoutSeconds = parseDurationToSeconds(value);
				index++;
			}
		} else if (token === "--iter-timeout") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				iterTimeoutSeconds = parseDurationToSeconds(value);
				index++;
			}
		} else if (token === "--retry-on-error" || token === "--retry") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				retryOnError = Number.parseInt(value, 10) || 0;
				index++;
			}
		} else if (token === "--until-cmd" || token === "--until-command") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				untilCmd = value;
				index++;
			}
		} else if (token === "--retry-delay") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				retryDelayMs = Number.parseInt(value, 10) || 1000;
				index++;
			}
		} else if (token === "--until-cmd-timeout") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				untilCmdTimeoutMs = parseDurationToSeconds(value) * 1000 || CMD_DEFAULT_TIMEOUT_MS;
				index++;
			}
		} else if (token === "--max-failures") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				maxFailures = Number.parseInt(value, 10) || 0;
				index++;
			}
		} else if (token === "--until-cmd-fail" || token === "--until-command-fail") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				untilCmdFail = value;
				index++;
			}
		} else if (token === "--on-start" || token === "--on-start-cmd") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				onStart = value;
				index++;
			}
		} else if (token === "--on-fail" || token === "--on-fail-cmd") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				onFail = value;
				index++;
			}
		} else if (token === "--on-stop" || token === "--on-stop-cmd") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				onStop = value;
				index++;
			}
		} else if (token === "--on-iter" || token === "--on-iter-cmd") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				onIter = value;
				index++;
			}
		} else if (token === "--hook-timeout") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				hookTimeoutMs = parseDurationToSeconds(value) * 1000 || 30_000;
				index++;
			}
		} else if (token === "--yes" || token === "-y" || token === "--auto" || token === "--yolo") {
			autoPilot = true;
		} else if (token === "--stop-on-error") {
			stopOnError = true;
		} else if (token === "--error-markers") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				errorMarkers = value
					.split("|")
					.map((m) => m.trim())
					.filter(Boolean);
				index++;
			}
		} else if (token === "--name") {
			const value = tokens[index + 1];
			if (value !== undefined) {
				name = value;
				index++;
			}
		} else if (token === "--quiet" || token === "-q") {
			quiet = true;
		} else if (token === "--notify") {
			notify = true;
		} else if (token === "--sound") {
			sound = true;
		} else {
			promptTokens.push(token);
		}
	}

	return {
		prompt: promptTokens.join(" ").trim(),
		maxIterations,
		stopTexts,
		stopRegexStrings,
		autoPilot,
		delayMs,
		timeoutSeconds,
		iterTimeoutSeconds,
		stopOnError,
		errorMarkers,
		quiet,
		untilStable,
		untilAll,
		maxFailures,
		retryOnError,
		retryDelayMs,
		untilCmdTimeoutMs,
		untilCmd,
		untilCmdFail,
		name,
		onStart,
		onFail,
		onStop,
		hookTimeoutMs,
		onIter,
		untilStableSim,
		untilConverged,
		delayJitterPct,
		notify,
		sound,
	};
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal) {
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal.addEventListener("abort", onAbort, { once: true });
		} else {
			setTimeout(resolve, ms);
		}
	});
}

function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.round(seconds % 60);
	return `${minutes}m ${remainder}s`;
}

/**
 * Render prompt templating tokens for a given iteration.
 * {{n}}/{{N}} -> iteration number; {{prev}} -> prior assistant reply.
 */
/**
 * Expand indexed template tokens that need a reply index:
 *   {{prev:N}} -> Nth-previous reply (1 = immediate prior); empty if unavailable
 *   {{last:N}} -> last N characters of the immediate prior reply
 */
function expandIndexedTemplates(template: string, replyHistory: string[]): string {
	const prior = (n: number): string => {
		const idx = replyHistory.length - n;
		const reply = replyHistory[idx];
		return reply ? truncateText(reply.replace(/\s+/g, " ").trim(), MAX_PREV_CHARS) : "";
	};
	return template
		.replace(/\{\{prev:(\d+)\}\}/g, (_m, digits) => prior(Number(digits)))
		.replace(/\{\{last:(\d+)\}\}/g, (_m, digits) => {
			const n = Number(digits);
			const collapsed = replyHistory.length
				? replyHistory[replyHistory.length - 1]!.replace(/\s+/g, " ").trim()
				: "";
			return collapsed.slice(-n);
		});
}

/**
 * Render prompt templating tokens for a given iteration.
 * {{n}}/{{N}}/{{i}} -> iteration number; {{prev}} -> prior assistant reply;
 * {{prev:N}} -> Nth-prior reply; {{last:N}} -> last N chars of prior reply;
 * {{all}} -> all prior replies (joined by '---'); {{count}} -> completed prior iterations;
 * {{max}}/{{MAX}} -> max iterations (or ∞); {{ts}} -> ISO timestamp.
 */
function renderPrompt(
	template: string,
	iteration: number,
	previousReply: string,
	maxLabel = "\u221E",
	replyHistory: string[] = [],
): string {
	const prevCollapsed = previousReply.replace(/\s+/g, " ").trim();
	const expanded = expandIndexedTemplates(template, replyHistory);
	return substituteTokens(expanded, {
		n: String(iteration),
		N: String(iteration),
		i: String(iteration),
		prev: truncateText(prevCollapsed, MAX_PREV_CHARS),
		prev1: truncateText(prevCollapsed, MAX_PREV_CHARS),
		prev2: replyHistory.length >= 2 ? truncateText(replyHistory[replyHistory.length - 2]!.replace(/\s+/g, " ").trim(), MAX_PREV_CHARS) : "",
		prev3: replyHistory.length >= 3 ? truncateText(replyHistory[replyHistory.length - 3]!.replace(/\s+/g, " ").trim(), MAX_PREV_CHARS) : "",
		all: replyHistory.map((r) => r.replace(/\s+/g, " ").trim()).join("\n---\n"),
		count: String(replyHistory.length),
		max: maxLabel,
		MAX: maxLabel,
		ts: new Date().toISOString(),
	});
}

function messageToText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block: any) => (block?.type === "text" ? block.text ?? "" : ""))
			.join(" ");
	}
	return "";
}

function getLastAssistantText(ctx: any): string {
	const entries = ctx?.sessionManager?.getEntries?.() ?? [];
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.role === "assistant") {
			return messageToText(entries[index]);
		}
	}
	return "";
}


function replyHasErrorMarker(text: string, markers: string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

/**
 * Wait until the just-sent turn has started and then fully settled.
 * Polls briefly for the turn to begin, then delegates to ctx.waitForIdle().
 * If iterTimeoutMs > 0, the wait races against that timeout; returns false
 * when the timeout elapses before the turn settles (so the caller can abort).
 */
async function waitForTurnToSettle(
	ctx: any,
	controller: LoopController,
	iterTimeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + TURN_START_GRACE_MS;
	while (Date.now() < deadline) {
		if (controller.stopRequested) return true; // will break anyway
		if (!ctx.isIdle()) break; // turn has started
		await sleep(POLL_INTERVAL_MS);
	}
	if (ctx.isIdle()) return true; // never started (edge) — treat as settled
	if (iterTimeoutMs > 0) {
		await Promise.race([ctx.waitForIdle(), sleep(iterTimeoutMs)]);
		return ctx.isIdle();
	}
	const settledWithinDefault = await Promise.race([
		ctx.waitForIdle().then(() => true),
		sleep(DEFAULT_TURN_TIMEOUT_MS).then(() => false),
	]);
	return settledWithinDefault && ctx.isIdle();
}

function reasonToText(reason: StopReason): string {
	switch (reason) {
		case "max":
			return "reached max iterations";
		case "until":
			return "stop condition met";
		case "user":
			return "stopped by user (loop stop)";
		case "manual":
			return "stopped at confirmation";
		case "error":
			return "error detected";
		case "timeout":
			return "wall-clock timeout";
		case "itertimeout":
			return "iteration timeout (--iter-timeout)";
		case "stall":
			return "stalled (no assistant response)";
		case "cmd":
			return "verification command succeeded";
		case "cmdfail":
			return "verification command failed";
		case "maxfailures":
			return "max consecutive failures reached";
		case "stable":
			return "converged (--until-stable)";
		case "converged":
			return "converged (--until-converged)";
		case "stop":
			return "cancelled";
		default:
			return "completed";
	}
}

function runShellCommand(
	command: string,
	timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof exec> | undefined;
		const timer = setTimeout(() => {
			child?.kill("SIGTERM");
			resolve({ ok: false, output: "(command timed out)" });
		}, timeoutMs);
		child = exec(command, { maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
			clearTimeout(timer);
			resolve({ ok: !error, output: (stdout + stderr).toString().trim() });
		});
	});
}

// ─── Rich TUI widget ───────────────────────────────────────────────────────
// Animated, boxed live-status panel rendered via ctx.ui.setWidget. A single
// module-level timer drives re-renders so the spinner/progress advance smoothly
// without leaking intervals; it is cleared when the loop ends (finally block).

type LoopPhase = "idle" | "arming" | "sending" | "waiting" | "settling" | "done";

// Minimal shapes for the widget host (Pi supplies the concrete objects).
interface LoopTheme {
	fg(color: string, text: string): string;
}
interface LoopWidgetTui {
	requestRender?: () => void;
}
interface LoopWidgetRenderer {
	render: () => string[];
	invalidate: () => void;
}
interface LoopPanelState {
	controller: LoopController;
	options: LoopOptions;
	elapsedMs: number;
	avgIterMs: number;
	lastReply: string;
}
// Anything that can host the widget — only the widget-capable bits are needed.
interface LoopContextLike {
	ui?: {
		setWidget?: (id: string, renderer: unknown) => void;
		setStatus?: (id: string, text: unknown) => void;
	};
}

// Semantic → theme colour key. Centralised so the palette stays consistent.
const LOOP_COLORS = {
	accent: "accent",
	muted: "muted",
	dim: "dim",
	warning: "warning",
	success: "success",
	error: "error",
	border: "borderAccent",
} as const;

const LOOP_ICONS = {
	loop: "⟳",
	reply: "↳",
	stop: "⊘",
} as const;

const PANEL_WIDTH = 46;
const PANEL_INNER = PANEL_WIDTH - 4;
const PANEL_LABEL_COL = 7;
const PROGRESS_BAR_WIDTH = 20;
const CONVERGENCE_BAR_WIDTH = 10;
const SPINNER_INTERVAL_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let loopWidgetTui: LoopWidgetTui | null = null;
let loopWidgetAnimTimer: ReturnType<typeof setInterval> | null = null;
let loopPhase: LoopPhase = "idle";
let loopWidgetSimilarity: number | null = null;
let loopWidgetState: LoopPanelState | null = null;

function ansiStrip(input: string): string {
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}
function visLen(input: string): number {
	return ansiStrip(input).length;
}
function truncateVis(input: string, max: number): string {
	if (max <= 0) return "";
	let out = "";
	let count = 0;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (ch === "\x1b") {
			let j = i;
			while (j < input.length && input[j] !== "m") j++;
			out += input.slice(i, j + 1);
			i = j;
			continue;
		}
		if (count >= max) break;
		out += ch;
		count++;
	}
	return out;
}
function padEndVis(input: string, width: number): string {
	const shortage = width - visLen(input);
	return shortage > 0 ? input + " ".repeat(shortage) : input;
}
function spinFrame(intervalMs = 100): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / intervalMs) % SPINNER_FRAMES.length]!;
}
function progressBar(fraction: number | null, width: number, theme: LoopTheme): string {
	const cells = width;
	if (fraction === null) {
		// Indeterminate: a bright segment glides across the track.
		const seg = 3;
		const total = cells + seg;
		const start = Math.floor(Date.now() / 140) % total;
		let bar = "";
		for (let i = 0; i < cells; i++) {
			const on = i >= start && i < start + seg;
			bar += on ? theme.fg("accent", "█") : theme.fg("dim", "░");
		}
		return bar;
	}
	const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
	let bar = "";
	for (let i = 0; i < cells; i++) {
		bar += i < filled ? theme.fg("accent", "█") : theme.fg("dim", "░");
	}
	return bar;
}
function convergenceBar(similarity: number, width: number, theme: LoopTheme): string {
	const filled = Math.max(0, Math.min(width, Math.round(similarity * width)));
	let bar = "";
	for (let i = 0; i < width; i++) {
		bar += theme.fg(i < filled ? "success" : "dim", "█");
	}
	return bar;
}
function panelBorderTop(theme: LoopTheme): string {
	return theme.fg(LOOP_COLORS.border, "╭" + "─".repeat(PANEL_WIDTH - 2) + "╮");
}
function panelBorderBottom(theme: LoopTheme): string {
	return theme.fg(LOOP_COLORS.border, "╰" + "─".repeat(PANEL_WIDTH - 2) + "╯");
}
function panelLine(content: string, theme: LoopTheme): string {
	const inner = PANEL_INNER;
	const safe = truncateVis(content, inner);
	const padded = padEndVis(safe, inner);
	return theme.fg(LOOP_COLORS.border, "│ ") + padded + theme.fg(LOOP_COLORS.border, " │");
}

const PHASE_STYLE: Record<LoopPhase, { label: string; color: string }> = {
	idle: { label: "idle", color: "muted" },
	arming: { label: "arming", color: "dim" },
	sending: { label: "sending", color: "accent" },
	waiting: { label: "waiting", color: "accent" },
	settling: { label: "checking", color: "warning" },
	done: { label: "done", color: "success" },
};

// Aligned label/value row: the label column is fixed-width so values line up.
function panelField(label: string, value: string, theme: LoopTheme): string {
	const alignedLabel = label + " ".repeat(Math.max(0, PANEL_LABEL_COL - visLen(label)));
	return panelLine(theme.fg(LOOP_COLORS.muted, alignedLabel) + theme.fg(LOOP_COLORS.dim, value), theme);
}

function renderLoopPanel(theme: LoopTheme): string[] {
	const state = loopWidgetState;
	if (!state) return [];
	const { controller, options, elapsedMs, avgIterMs, lastReply } = state;
	const maxLabel = options.maxIterations > 0 ? String(options.maxIterations) : "∞";
	const lines: string[] = [];
	lines.push(panelBorderTop(theme));

	const title = theme.fg(LOOP_COLORS.accent, `${LOOP_ICONS.loop} /loop`) + "  " + theme.fg(LOOP_COLORS.muted, `iter ${controller.iteration}/${maxLabel}`);
	lines.push(panelLine(title, theme));

	const progressFraction = options.maxIterations > 0 ? Math.min(1, controller.iteration / options.maxIterations) : null;
	const progressPercent = progressFraction === null ? "∞" : `${Math.round(progressFraction * 100)}%`;
	lines.push(panelLine(progressBar(progressFraction, PROGRESS_BAR_WIDTH, theme) + " " + theme.fg(LOOP_COLORS.dim, progressPercent), theme));

	const phaseStyle = PHASE_STYLE[loopPhase];
	lines.push(
		panelLine(
			spinFrame() + " " + theme.fg(phaseStyle.color, phaseStyle.label) + "   " + theme.fg(LOOP_COLORS.muted, formatDuration(elapsedMs)),
			theme,
		),
	);

	if (options.maxIterations > 0 && avgIterMs > 0) {
		const remaining = options.maxIterations - controller.iteration;
		if (remaining > 0) {
			lines.push(
				panelField(
					"ETA",
					formatDuration(remaining * avgIterMs) + "  avg " + formatDuration(avgIterMs) + "/it",
					theme,
				),
			);
		}
	}
	if (options.name) lines.push(panelField("tag", options.name, theme));
	if (options.stopTexts.length) {
		lines.push(panelField("stop", options.stopTexts.map((t) => `"${t}"`).join(" | "), theme));
	}
	if (options.stopRegexStrings.length) {
		lines.push(panelField("regex", options.stopRegexStrings.map((r) => `/${r}/`).join(" | "), theme));
	}
	if (options.untilStable > 0) {
		lines.push(panelField("stable", `after ${options.untilStable} alike`, theme));
	}
	if (loopWidgetSimilarity !== null) {
		const similarityPercent = `${Math.round(loopWidgetSimilarity * 100)}%`;
		lines.push(panelField("conv", convergenceBar(loopWidgetSimilarity, CONVERGENCE_BAR_WIDTH, theme) + " " + similarityPercent, theme));
	}
	const snippet = truncateVis(lastReply.replace(/\s+/g, " ").trim(), PANEL_WIDTH - 8);
	if (snippet) {
		lines.push(panelLine(theme.fg(LOOP_COLORS.muted, `${LOOP_ICONS.reply} `) + theme.fg(LOOP_COLORS.dim, snippet), theme));
	}
	lines.push(panelLine(theme.fg(LOOP_COLORS.dim, `${LOOP_ICONS.stop} /loop stop to cancel`), theme));
	lines.push(panelBorderBottom(theme));
	return lines;
}

function startLoopWidgetAnimation(): void {
	if (loopWidgetAnimTimer) return;
	loopWidgetAnimTimer = setInterval(() => {
		loopWidgetTui?.requestRender?.();
	}, SPINNER_INTERVAL_MS);
	if (typeof loopWidgetAnimTimer.unref === "function") loopWidgetAnimTimer.unref();
}
function stopLoopWidgetAnimation(): void {
	if (loopWidgetAnimTimer) {
		clearInterval(loopWidgetAnimTimer);
		loopWidgetAnimTimer = null;
	}
	loopWidgetTui = null;
}

function buildLoopWidget(
	controller: LoopController,
	options: LoopOptions,
	elapsedMs: number,
	avgIterMs: number,
	lastReply: string,
): (tui: LoopWidgetTui, theme: LoopTheme) => LoopWidgetRenderer {
	loopWidgetState = { controller, options, elapsedMs, avgIterMs, lastReply };
	return (tui: LoopWidgetTui, theme: LoopTheme): LoopWidgetRenderer => {
		loopWidgetTui = tui;
		startLoopWidgetAnimation();
		return {
			render: () => {
				try {
					return renderLoopPanel(theme);
				} catch {
					// A render error must never crash the loop's UI timer.
					return [];
				}
			},
			invalidate: () => {},
		};
	};
}

// Show/hide helpers: never throw if the context lacks a widget-capable UI.
function showLoopPanel(
	context: LoopContextLike,
	factory: (tui: LoopWidgetTui, theme: LoopTheme) => LoopWidgetRenderer,
): void {
	try {
		context.ui?.setWidget?.("loop", factory);
	} catch {
		// Widget UI unavailable; the loop still runs, just without the panel.
	}
}
function hideLoopPanel(context: LoopContextLike): void {
	try {
		context.ui?.setWidget?.("loop", undefined);
		context.ui?.setStatus?.("loop", undefined);
	} catch {
		// Ignore cleanup failures.
	}
}

// Best-effort completion cues. Both are guarded so they can never affect the loop.
function sendCompletionSound(): void {
	try {
		process.stdout.write("\x07");
	} catch {
		// Terminal bell unsupported; ignore.
	}
}

function escapeShellArg(input: string): string {
	return input.replace(/'/g, "''");
}

function sendDesktopNotification(title: string, message: string): void {
	try {
		if (process.platform === "darwin") {
			execFileSync("osascript", ["-e", `display notification "${escapeShellArg(message)}" with title "${escapeShellArg(title)}"`], { stdio: "ignore" });
		} else if (process.platform === "linux") {
			execFileSync("notify-send", [title, message], { stdio: "ignore" });
		} else if (process.platform === "win32") {
			const powershellScript = [
				"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
				"$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
				"$texts = $template.GetElementsByTagName('text')",
				`$texts.Item(0).AppendChild($template.CreateTextNode('${escapeShellArg(title)}')) > $null`,
				`$texts.Item(1).AppendChild($template.CreateTextNode('${escapeShellArg(message)}')) > $null`,
				"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
				"$xml.LoadXml($template.OuterXml)",
				"$toast = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi Loop')",
				"$toast.Show($xml)",
			].join("\n");
			execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", powershellScript], { stdio: "ignore", windowsHide: true });
		}
	} catch {
		// Notification subsystem unavailable; ignore.
	}
}

// ─── Persistent state (presets + last config) ─────────────────────────────

async function readLoopState(): Promise<LoopState> {
	try {
		const raw = await readFile(LOOP_STATE_FILE, "utf8");
		const parsed = JSON.parse(raw) as Partial<LoopState>;
		return { last: parsed.last ?? null, presets: parsed.presets ?? {} };
	} catch {
		return { last: null, presets: {} };
	}
}

async function writeLoopState(state: LoopState): Promise<void> {
	try {
		await mkdir(LOOP_STATE_DIR, { recursive: true });
		await writeFile(LOOP_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
	} catch {
		// Non-fatal: presets are a convenience, never block the loop.
	}
}

async function saveLastConfig(options: LoopOptions): Promise<void> {
	const state = await readLoopState();
	state.last = options;
	await writeLoopState(state);
}

async function savePreset(name: string, options: LoopOptions): Promise<void> {
	const state = await readLoopState();
	state.presets[name] = options;
	await writeLoopState(state);
}

function formatOptionsSummary(options: LoopOptions): string {
	const flags: string[] = [];
	if (options.maxIterations !== DEFAULT_MAX_ITERATIONS) flags.push(`--max ${options.maxIterations}`);
	options.stopTexts.forEach((t) => flags.push(`--until "${t}"`));
	options.stopRegexStrings.forEach((r) => flags.push(`--until-regex "${r}"`));
	if (options.untilStable > 0) flags.push(`--until-stable ${options.untilStable}`);
	if (options.autoPilot) flags.push("--yes");
	if (options.delayMs > 0) flags.push(`--delay ${options.delayMs}`);
	if (options.timeoutSeconds > 0) flags.push(`--timeout ${options.timeoutSeconds}`);
	if (options.iterTimeoutSeconds > 0) flags.push(`--iter-timeout ${options.iterTimeoutSeconds}`);
	if (options.retryOnError > 0) flags.push(`--retry-on-error ${options.retryOnError}`);
	if (options.untilCmd) flags.push(`--until-cmd ${JSON.stringify(options.untilCmd)}`);
	if (options.retryDelayMs !== 1000) flags.push(`--retry-delay ${options.retryDelayMs}`);
	if (options.untilCmdTimeoutMs !== CMD_DEFAULT_TIMEOUT_MS) flags.push(`--until-cmd-timeout ${options.untilCmdTimeoutMs}ms`);
	if (options.untilAll) flags.push("--until-all");
	if (options.maxFailures > 0) flags.push(`--max-failures ${options.maxFailures}`);
	if (options.untilCmdFail) flags.push(`--until-cmd-fail ${JSON.stringify(options.untilCmdFail)}`);
	if (options.onStart) flags.push(`--on-start ${JSON.stringify(options.onStart)}`);
	if (options.onFail) flags.push(`--on-fail ${JSON.stringify(options.onFail)}`);
	if (options.onStop) flags.push(`--on-stop ${JSON.stringify(options.onStop)}`);
	if (options.hookTimeoutMs !== 30_000) flags.push(`--hook-timeout ${Math.round(options.hookTimeoutMs / 1000)}s`);
	if (options.untilStableSim > 0) flags.push(`--until-stable-sim ${options.untilStableSim}`);
	if (options.untilConverged > 0) flags.push(`--until-converged ${options.untilConverged}`);
	if (options.onIter) flags.push(`--on-iter ${JSON.stringify(options.onIter)}`);
	if (options.delayJitterPct > 0) flags.push(`--delay-jitter ${options.delayJitterPct}`);
	if (options.stopOnError) flags.push("--stop-on-error");
	if (options.errorMarkers.length) flags.push(`--error-markers "${options.errorMarkers.join("|")}"`);
	if (options.name) flags.push(`--name ${options.name}`);
	if (options.quiet) flags.push("--quiet");
	if (options.notify) flags.push("--notify");
	if (options.sound) flags.push("--sound");
	return `/loop "${options.prompt}"${flags.length ? " " + flags.join(" ") : ""}`;
}

// ─── Run log ──────────────────────────────────────────────────────────────

async function writeLoopLog(
	entries: LoopLogEntry[],
	meta: { reason: StopReason; totalMs: number; options: LoopOptions },
): Promise<string | null> {
	try {
		await mkdir(LOOP_LOG_DIR, { recursive: true });
		const safeTag = meta.options.name
			? meta.options.name.replace(/[^a-z0-9_-]/gi, "") + "-"
			: "";
		const fileName = `loop-${safeTag}${Date.now()}.json`;
		const filePath = join(LOOP_LOG_DIR, fileName);
		await writeFile(filePath, JSON.stringify({ meta, entries }, null, 2), "utf8");
		// Keep only the most recent MAX_LOG_FILES logs.
		const files = (await readdir(LOOP_LOG_DIR))
			.filter((f) => f.startsWith("loop-") && f.endsWith(".json"))
			.sort();
		while (files.length > MAX_LOG_FILES) {
			const oldest = files.shift();
			if (oldest) await unlink(join(LOOP_LOG_DIR, oldest));
		}
		return filePath;
	} catch {
		return null;
	}
}

async function listLoopLogFiles(): Promise<string[]> {
	try {
		const files = await readdir(LOOP_LOG_DIR);
		return files
			.filter((f) => f.startsWith("loop-") && f.endsWith(".json"))
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

// ─── Loop execution ───────────────────────────────────────────────────────

async function runLoop(pi: ExtensionAPI, options: LoopOptions, ctx: any): Promise<void> {
	// Non-interactive contexts cannot confirm; fall back to autopilot.
	if (!options.autoPilot && !ctx.hasUI) {
		ctx.ui.notify("No UI available — running in autopilot (--yes).", "warning");
		options.autoPilot = true;
	}

	// YOLO / autopilot: never block on any confirmation. While --auto is active, wrap
	// ctx.ui.confirm so every approval (including any surfaced by the running turn) resolves
	// to yes. Restored in the finally block so other commands are unaffected.
	const originalConfirm = ctx.ui?.confirm;
	if (options.autoPilot && ctx.ui && originalConfirm) {
		ctx.ui.confirm = async () => true;
	}

	const controller: LoopController = {
		active: true,
		stopRequested: false,
		iteration: 0,
		requestStop() {
			this.stopRequested = true;
		},
	};
	activeLoop = controller;

	const loopStartedAt = Date.now();
	const logEntries: LoopLogEntry[] = [];
	const replyHistory: string[] = [];
	let lastReply = "";
	let stopReason: StopReason = "done";
	let retryThisIteration = false;
	let retriesRemaining = 0;
	let consecutiveFailures = 0;

	// Compile regex stop conditions once; invalid patterns are dropped.
	const stopRegexes = options.stopRegexStrings
		.map((pattern) => {
			try {
				return new RegExp(pattern);
			} catch {
				return null;
			}
		})
		.filter((re): re is RegExp => re !== null);
	if (stopRegexes.length < options.stopRegexStrings.length) {
		ctx.ui.notify("Some --until-regex patterns were invalid and ignored.", "warning");
	}

	const effectiveMarkers = options.errorMarkers.length
		? options.errorMarkers
		: DEFAULT_ERROR_MARKERS;

	const hasMax = options.maxIterations > 0;
	const maxLabel = hasMax ? String(options.maxIterations) : "\u221E";

	// Run a lifecycle hook command with token substitution. Failures are reported but never abort the loop.
	const fireHook = async (label: string, command: string, vars: Record<string, string>): Promise<void> => {
		if (!command) return;
		const rendered = substituteTokens(command, vars);
		try {
			const result = await runShellCommand(rendered, options.hookTimeoutMs);
			if (result.output) {
				ctx.ui.notify(`${label} hook output:\n${truncateText(result.output, 1000)}`, "info");
			}
		} catch (hookErr) {
			ctx.ui.notify(
				`${label} hook failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
				"warning",
			);
		}
	};

	const iterTimeoutMs = options.iterTimeoutSeconds * 1000;
	const isTimedOut = (): boolean =>
		options.timeoutSeconds > 0 &&
		Date.now() - loopStartedAt > options.timeoutSeconds * 1000;

	const hasAnyStop =
		options.stopTexts.length > 0 ||
		options.stopRegexStrings.length > 0 ||
		options.untilStable > 0 ||
		options.timeoutSeconds > 0 ||
		options.iterTimeoutSeconds > 0 ||
		options.stopOnError ||
		options.retryOnError > 0 ||
		options.untilCmd.length > 0 ||
		options.untilConverged > 0;
	if (!hasMax && !hasAnyStop) {
		ctx.ui.notify(
			"Unbounded loop with no stop condition — it will run until you send /loop stop (or it hits an error).",
			"warning",
		);
	}

	// Pre-flight: if the verification command already passes, there is nothing to do.
	if (options.untilCmd) {
		const pre = await runShellCommand(options.untilCmd, options.untilCmdTimeoutMs);
		if (pre.ok) {
			ctx.ui.notify(
				`Loop verification already satisfied before iteration 1 — nothing to do:\n${truncateText(pre.output, 2000)}`,
				"info",
			);
			stopReason = "cmd";
		} else if (pre.output) {
			ctx.ui.notify(
				`Verification command pre-check returned non-zero; proceeding:\n${truncateText(pre.output, 800)}`,
				"warning",
			);
		}
	}

	// Pre-flight (fail-mode): if the command already fails, nothing to monitor.
	if (options.untilCmdFail) {
		const preFail = await runShellCommand(options.untilCmdFail, options.untilCmdTimeoutMs);
		if (!preFail.ok) {
			ctx.ui.notify(
				`Loop verification (fail-mode) already failed before iteration 1 — nothing to do:\n${truncateText(preFail.output, 2000)}`,
				"info",
			);
			stopReason = "cmdfail";
		} else if (preFail.output) {
			ctx.ui.notify(
				`--until-cmd-fail pre-check still succeeds; proceeding:\n${truncateText(preFail.output, 800)}`,
				"warning",
			);
		}
	}

	// Lifecycle hook: on-start fires once, just before the first iteration, but only if the loop
	// will actually run (skip when a pre-flight check already satisfied the stop condition).
	if (stopReason === "done" && options.onStart) {
		await fireHook("on-start", options.onStart, {
			i: "0",
			n: "0",
			max: maxLabel,
			name: options.name,
			reason: "start",
			reply: "",
			prev: "",
		});
	}

	// Rich TUI: animated live-status panel. The panel owns the animation, so we
	// intentionally do NOT also override the global working indicator (that would
	// show a second, competing spinner).
	loopPhase = "arming";
	startLoopWidgetAnimation();

	try {
		while (
			controller.active &&
			!controller.stopRequested &&
			(!hasMax || controller.iteration < options.maxIterations) &&
			!isTimedOut()
		) {
			if (stopReason === "cmd" || stopReason === "cmdfail") break;
			if (!retryThisIteration) {
				controller.iteration++;
				retriesRemaining = options.retryOnError;
			}
			const iterationLabel = `loop: ${controller.iteration}/${maxLabel}`;
			const elapsed = Date.now() - loopStartedAt;
			const avgIterMs = elapsed / Math.max(controller.iteration, 1);
			const iterationStartedAt = Date.now();

			ctx.ui.setStatus("loop", iterationLabel);
			loopPhase = "arming";
			showLoopPanel(ctx, buildLoopWidget(controller, options, elapsed, avgIterMs, lastReply));
			if (!options.quiet && !retryThisIteration) {
				ctx.ui.notify(`/loop iteration ${controller.iteration} started`, "info");
			}

			// Send the (templated) prompt; isolate per-iteration failures so one
			// bad turn can't crash the whole loop.
			const promptText = retryThisIteration ? options.prompt + RETRY_NUDGE : options.prompt;
			const rendered = renderPrompt(promptText, controller.iteration, lastReply, maxLabel, replyHistory);
			try {
				pi.sendUserMessage(rendered);
				loopPhase = "waiting";
				const settled = await waitForTurnToSettle(ctx, controller, iterTimeoutMs);
				if (!settled) {
					ctx.ui.notify(
						`Loop stopped: iteration ${controller.iteration} exceeded the turn timeout (default ${Math.round(DEFAULT_TURN_TIMEOUT_MS / 60000)}m; override with --iter-timeout)`,
						"error",
					);
					stopReason = "itertimeout";
					break;
				}
			} catch (sendError) {
				const message = sendError instanceof Error ? sendError.message : String(sendError);
				ctx.ui.notify(`Loop aborted at iteration ${controller.iteration}: ${message}`, "error");
				stopReason = "error";
				break;
			}

			if (controller.stopRequested) {
				stopReason = "stop";
				break;
			}

			loopPhase = "settling";

			// Stall detection: the turn should have produced a new assistant reply.
			// Poll briefly after the turn settles to absorb the entry-commit race
			// (waitForIdle can resolve a tick before the reply is flushed to the session).
			let newReply = getLastAssistantText(ctx);
			const stallDeadline = Date.now() + STALL_SETTLE_GRACE_MS;
			while (newReply.trim() === "" && Date.now() < stallDeadline) {
				await sleep(POLL_INTERVAL_MS);
				newReply = getLastAssistantText(ctx);
			}
			if (newReply.trim() === "") {
				ctx.ui.notify(
					`Loop stalled: iteration ${controller.iteration} produced no assistant response`,
					"warning",
				);
				stopReason = "stall";
				break;
			}

			lastReply = newReply;
			replyHistory.push(lastReply);
			loopPhase = "done";
			loopWidgetSimilarity = replyHistory.length >= 2
				? similarityRatio(replyHistory[replyHistory.length - 1]!, replyHistory[replyHistory.length - 2]!)
				: null;
			const iterationDuration = Date.now() - iterationStartedAt;
			logEntries.push({
				iteration: controller.iteration,
				prompt: rendered,
				summary: truncateText(lastReply.replace(/\s+/g, " ").trim(), 400),
				durationMs: iterationDuration,
			});
			showLoopPanel(ctx, buildLoopWidget(controller, options, elapsed, avgIterMs, lastReply));

			// Stop condition: --until text / regex.
			if (options.untilAll) {
				const textsOk = options.stopTexts.every((text) => lastReply.includes(text));
				const regexesOk = options.stopRegexStrings.every((_pattern, i) => stopRegexes[i].test(lastReply));
				const hasAny = options.stopTexts.length > 0 || options.stopRegexStrings.length > 0;
				if (hasAny && textsOk && regexesOk) {
					ctx.ui.notify(
						`Loop stop condition met (all required): ${[...options.stopTexts, ...options.stopRegexStrings].join(" + ")}`,
						"info",
					);
					stopReason = "until";
					break;
				}
			} else {
				const matchedUntil = options.stopTexts.find((text) => lastReply.includes(text));
				const matchedRegex = stopRegexes.find((re) => re.test(lastReply));
				if (matchedUntil || matchedRegex) {
					ctx.ui.notify(
						matchedRegex
							? "Loop stop condition met (regex)."
							: `Loop stop condition met: "${matchedUntil}".`,
						"info",
					);
					stopReason = "until";
					break;
				}
			}

			// Stop condition: convergence — last N replies identical (or similar, with --until-stable-sim).
			if (options.untilStable > 0 && replyHistory.length >= options.untilStable) {
				const window = replyHistory.slice(-options.untilStable);
				const converged =
					options.untilStableSim > 0
						? window.every(
								(r, idx) => idx === 0 || similarityRatio(r, window[idx - 1]) >= options.untilStableSim,
							)
					: window.every((r) => r === lastReply);
				if (converged) {
					ctx.ui.notify(
						options.untilStableSim > 0
							? `Loop converged: last ${options.untilStable} replies ≥ ${options.untilStableSim} similar`
							: `Loop converged: last ${options.untilStable} replies identical`,
						"info",
					);
					stopReason = "stable";
					break;
				}
			}

			// Stop condition: convergence — single-step similarity threshold.
			if (options.untilConverged > 0 && loopWidgetSimilarity !== null && loopWidgetSimilarity * 100 >= options.untilConverged) {
				ctx.ui.notify(
					`Loop converged: similarity ${Math.round(loopWidgetSimilarity * 100)}% ≥ --until-converged ${options.untilConverged}%`,
					"info",
				);
				stopReason = "converged";
				break;
			}

			// Stop condition: error marker detected.
			if (replyHasErrorMarker(lastReply, effectiveMarkers)) {
				if (retriesRemaining > 0) {
					retriesRemaining--;
					const retryAttempt = options.retryOnError - retriesRemaining;
					const backoffMs = Math.min(
						options.retryDelayMs * 2 ** (retryAttempt - 1),
						RETRY_BACKOFF_CAP_MS,
					);
					ctx.ui.notify(
						`Iteration ${controller.iteration} hit an error marker — retrying (${retriesRemaining} left, backoff ${formatDuration(backoffMs)})`,
						"warning",
					);
					if (backoffMs > 0) await sleep(backoffMs, ctx.signal);
					retryThisIteration = true;
					continue;
				}
				if (options.stopOnError) {
					ctx.ui.notify("Loop stopped: error marker in last reply", "error");
					await fireHook("on-fail", options.onFail, {
						i: String(controller.iteration),
						n: String(controller.iteration),
						max: maxLabel,
						name: options.name,
						reason: "error-marker",
						reply: getLastAssistantText(ctx),
						prev: lastReply,
					});
					stopReason = "error";
					break;
				}
				ctx.ui.notify(
					`Iteration ${controller.iteration} hit an error marker; continuing (--stop-on-error not set).`,
					"warning",
				);
				consecutiveFailures++;
				await fireHook("on-fail", options.onFail, {
					i: String(controller.iteration),
					n: String(controller.iteration),
					max: maxLabel,
					name: options.name,
					reason: "error-marker",
					reply: getLastAssistantText(ctx),
					prev: lastReply,
				});
				if (options.maxFailures > 0 && consecutiveFailures >= options.maxFailures) {
					ctx.ui.notify(
						`Loop stopped: ${consecutiveFailures} consecutive failures reached --max-failures`,
						"error",
					);
					stopReason = "maxfailures";
					break;
				}
			}
			if (!replyHasErrorMarker(lastReply, effectiveMarkers)) consecutiveFailures = 0;
			retryThisIteration = false;

			// Stop condition: external verification command succeeds (exit 0).
			if (options.untilCmd) {
				const result = await runShellCommand(options.untilCmd, options.untilCmdTimeoutMs);
				if (result.ok) {
					ctx.ui.notify(
						`Loop verification command succeeded:\n${truncateText(result.output, 2000)}`,
						"info",
					);
					stopReason = "cmd";
					break;
				}
				if (result.output) {
					ctx.ui.notify(
						`Verification command (iter ${controller.iteration}) returned non-zero; continuing:\n${truncateText(result.output, 800)}`,
						"warning",
					);
				}
			}

			// Stop condition: inverse verification — stop when the command FAILS (exit != 0).
			if (options.untilCmdFail) {
				const failResult = await runShellCommand(options.untilCmdFail, options.untilCmdTimeoutMs);
				if (!failResult.ok) {
					ctx.ui.notify(
						`Loop verification command failed (as desired):\n${truncateText(failResult.output, 2000)}`,
						"info",
					);
					stopReason = "cmdfail";
					break;
				}
				if (failResult.output) {
					ctx.ui.notify(
						`--until-cmd-fail command still succeeds (iter ${controller.iteration}); continuing:\n${truncateText(failResult.output, 800)}`,
						"warning",
					);
				}
			}

			// Continue decision (manual mode only).
			if (!options.autoPilot && ctx.hasUI) {
				const shouldContinue = await ctx.ui.confirm(
					`Continue to iteration ${controller.iteration + 1}?`,
					`${iterationLabel} complete. Approve the next round?`,
				);
				if (!shouldContinue) {
					ctx.ui.notify("Loop stopped at confirmation", "info");
					stopReason = "manual";
					break;
				}
			}

			// Lifecycle hook: on-iter fires once per iteration that runs to completion (reaches the
			// next-iteration path). It does not fire on an iteration that triggered a stop condition,
			// and in manual mode only fires when the user approves continuing.
			await fireHook("on-iter", options.onIter, {
				i: String(controller.iteration),
				n: String(controller.iteration),
				max: maxLabel,
				name: options.name,
				reason: "iteration",
				reply: lastReply,
				prev: replyHistory.length > 1 ? replyHistory[replyHistory.length - 2] : "",
			});

			// Optional inter-iteration delay.
			if (
				options.delayMs > 0 &&
				(!hasMax || controller.iteration < options.maxIterations) &&
				!controller.stopRequested &&
				!isTimedOut()
			) {
				let waitMs = options.delayMs;
				if (options.delayJitterPct > 0) {
					const jitter = (Math.random() * 2 - 1) * (options.delayJitterPct / 100);
					waitMs = Math.max(0, Math.round(options.delayMs * (1 + jitter)));
				}
				await sleep(waitMs, ctx.signal);
			}
		}

		if (stopReason === "done" && isTimedOut()) stopReason = "timeout";
		if (stopReason === "done") {
			stopReason = hasMax && controller.iteration >= options.maxIterations ? "max" : "done";
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Loop error: ${message}`, "error");
		stopReason = "error";
	} finally {
		const totalMs = Date.now() - loopStartedAt;
		controller.active = false;
		activeLoop = null;
		hideLoopPanel(ctx);
		loopPhase = "idle";
		stopLoopWidgetAnimation();
		try {
			ctx.ui.setWorkingIndicator?.();
		} catch {
			// Restore Pi's default working indicator; best-effort.
	}
		if (originalConfirm) ctx.ui.confirm = originalConfirm;
		const avgPerIter = logEntries.length ? totalMs / logEntries.length : 0;
		const avgText = logEntries.length ? ` (avg ${formatDuration(avgPerIter)}/iter)` : "";
		const logPath = await writeLoopLog(logEntries, {
			reason: stopReason,
			totalMs,
			options,
		});
		// Lifecycle hook: on-stop fires once when the loop ends, for any stop reason.
		await fireHook("on-stop", options.onStop, {
			i: String(controller.iteration),
			n: String(controller.iteration),
			max: maxLabel,
			name: options.name,
			reason: stopReason,
			reply: lastReply,
			prev: replyHistory.length > 1 ? replyHistory[replyHistory.length - 2] : "",
			iterations: String(controller.iteration),
		});

		const namePart = options.name ? ` (${options.name})` : "";
		const convergencePart = loopWidgetSimilarity !== null ? `, conv ${Math.round(loopWidgetSimilarity * 100)}%` : "";
		const summary = `Loop finished${namePart}: ${controller.iteration} iteration(s) in ${formatDuration(
			totalMs,
		)}${avgText} — ${reasonToText(stopReason)}${convergencePart}.${logPath ? ` Log: ${logPath}` : ""}`;
		ctx.ui.notify(summary, "info");
		if (options.notify) sendDesktopNotification("Pi /loop finished", `${controller.iteration} iteration(s) — ${reasonToText(stopReason)}`);
		if (options.sound) sendCompletionSound();
	}
}

// ─── Subcommands ──────────────────────────────────────────────────────────

async function handleResume(pi: ExtensionAPI, ctx: any): Promise<void> {
	const state = await readLoopState();
	if (!state.last) {
		ctx.ui.notify("No previous loop to resume. Run a /loop first.", "warning");
		return;
	}
	if (activeLoop && activeLoop.active) {
		ctx.ui.notify("A loop is already running. Send /loop stop to cancel.", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current turn to finish before starting a loop.", "warning");
		return;
	}
	await runLoop(pi, state.last, ctx);
}

async function handleSave(name: string, ctx: any): Promise<void> {
	const state = await readLoopState();
	if (!state.last) {
		ctx.ui.notify("No previous loop to save. Run a /loop first.", "warning");
		return;
	}
	await savePreset(name, state.last);
	ctx.ui.notify(`Saved preset "${name}": ${formatOptionsSummary(state.last)}`, "info");
}

async function handleLoad(name: string, pi: ExtensionAPI, ctx: any): Promise<void> {
	const state = await readLoopState();
	const preset = state.presets[name];
	if (!preset) {
		ctx.ui.notify(`No preset named "${name}". Use /loop list to see presets.`, "warning");
		return;
	}
	if (activeLoop && activeLoop.active) {
		ctx.ui.notify("A loop is already running. Send /loop stop to cancel.", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current turn to finish before starting a loop.", "warning");
		return;
	}
	await saveLastConfig(preset); // make resume target the loaded preset
	await runLoop(pi, preset, ctx);
}

async function handleList(ctx: any): Promise<void> {
	const state = await readLoopState();
	const lines: string[] = ["Pi-loop presets:"];
	const names = Object.keys(state.presets);
	if (names.length === 0) {
		lines.push("  (none saved)");
	} else {
		names.forEach((name) => lines.push(`  ${name}: ${formatOptionsSummary(state.presets[name])}`));
	}
	lines.push(state.last ? `Last: ${formatOptionsSummary(state.last)}` : "Last: (none)");
	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleDelete(name: string, ctx: any): Promise<void> {
	const state = await readLoopState();
	if (!state.presets[name]) {
		ctx.ui.notify(`No preset named "${name}".`, "warning");
		return;
	}
	delete state.presets[name];
	await writeLoopState(state);
	ctx.ui.notify(`Deleted preset "${name}".`, "info");
}

async function handleLast(ctx: any): Promise<void> {
	const state = await readLoopState();
	ctx.ui.notify(
		state.last ? formatOptionsSummary(state.last) : "No previous loop stored.",
		"info",
	);
}

/**
 * Aggregate run metrics from all loop logs.
 */
async function handleStats(ctx: any): Promise<void> {
	const files = await listLoopLogFiles();
	if (files.length === 0) {
		ctx.ui.notify("No loop logs yet.", "info");
		return;
	}
	let totalRuns = 0;
	let totalIters = 0;
	let totalMs = 0;
	const byReason: Record<string, number> = {};
	for (const file of files) {
		try {
			const data = JSON.parse(await readFile(join(LOOP_LOG_DIR, file), "utf8"));
			const meta = data.meta ?? {};
			totalRuns++;
			totalIters += data.entries?.length ?? 0;
			totalMs += meta.durationMs ?? 0;
			const reason = reasonToText(meta.reason ?? "done");
			byReason[reason] = (byReason[reason] ?? 0) + 1;
		} catch {
			// Skip unreadable logs.
		}
	}
	const lines = [
		`Loop stats over ${totalRuns} run(s):`,
		`  total iterations: ${totalIters}`,
		`  avg iterations/run: ${(totalIters / totalRuns).toFixed(1)}`,
		`  avg duration/run: ${formatDuration(totalMs / totalRuns)}`,
		"  stop reasons:",
	];
	for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
		lines.push(`    ${reason}: ${count}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * List recent run logs with a one-line summary each.
 */
async function handleLogs(ctx: any, tag: string): Promise<void> {
	let files = await listLoopLogFiles();
	if (tag) files = files.filter((f) => f.includes(tag));
	if (files.length === 0) {
		ctx.ui.notify(tag ? `No loop logs for "${tag}".` : "No loop logs yet.", "info");
		return;
	}
	const lines = [tag ? `Loop logs for "${tag}" (most recent first):` : "Recent loop logs (most recent first):"];
	for (const file of files.slice(0, 10)) {
		try {
			const data = JSON.parse(await readFile(join(LOOP_LOG_DIR, file), "utf8"));
			const meta = data.meta ?? {};
			const count = data.entries?.length ?? 0;
			lines.push(`  ${file}  —  ${count} iters, ${reasonToText(meta.reason ?? "done")}`);
		} catch {
			lines.push(`  ${file}`);
		}
	}
	lines.push("Use: /loop show <filename-or-index> (index 1 = most recent). Filter with: /loop logs <tag>");
	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Print a single run log. Accepts an index (1 = most recent), a filename, or
 * a substring of a filename. With no argument, shows the most recent log.
 */
async function handleShow(ctx: any, arg: string): Promise<void> {
	const files = await listLoopLogFiles();
	if (files.length === 0) {
		ctx.ui.notify("No loop logs yet.", "info");
		return;
	}
	let target: string | undefined;
	if (!arg) {
		target = files[0];
	} else if (/^\d+$/.test(arg)) {
		const index = Number.parseInt(arg, 10);
		target = files[index - 1];
	} else {
		target = files.find((f) => f === arg || f.includes(arg));
	}
	if (!target) {
		ctx.ui.notify(`No log matching "${arg}". Use /loop logs to list.`, "warning");
		return;
	}
	try {
		const data = JSON.parse(await readFile(join(LOOP_LOG_DIR, target), "utf8"));
		const meta = data.meta ?? {};
		const lines = [
			`Log: ${target}`,
			`Reason: ${reasonToText(meta.reason ?? "done")}`,
			`Total: ${formatDuration(meta.totalMs ?? 0)}`,
			"",
		];
		(data.entries ?? []).forEach((entry: LoopLogEntry) => {
			lines.push(`#${entry.iteration} (${formatDuration(entry.durationMs)})`);
			lines.push(`  prompt: ${entry.prompt}`);
			lines.push(`  result: ${entry.summary}`);
		});
		ctx.ui.notify(lines.join("\n"), "info");
	} catch {
		ctx.ui.notify(`Could not read log ${target}.`, "error");
	}
}

/**
 * Show the resolved config and every templated prompt without running.
 * Renders up to PREVIEW_ITERATION_CAP iterations so {{n}} progression is visible.
 */
async function handlePreview(args: string, ctx: any): Promise<void> {
	const options = parseLoopArgs(args);
	if (!options.prompt) {
		ctx.ui.notify(LOOP_USAGE, "warning");
		return;
	}
	const hasMax = options.maxIterations > 0;
	const cap = Math.min(options.maxIterations, PREVIEW_ITERATION_CAP);
	const lines = ["Loop preview (not running):", formatOptionsSummary(options), ""];
	if (options.onStart) lines.push(`on-start: ${options.onStart}`);
	if (options.onFail) lines.push(`on-fail:  ${options.onFail}`);
	if (options.onStop) lines.push(`on-stop:  ${options.onStop}`);
	if (options.onStart || options.onFail || options.onStop) lines.push("");
	for (let iteration = 1; iteration <= cap; iteration++) {
		lines.push(`#${iteration}: ${renderPrompt(options.prompt, iteration, "", hasMax ? String(options.maxIterations) : "\u221E", [])}`);
	}
	if (options.maxIterations > cap) {
		lines.push(`... (${options.maxIterations - cap} more iterations)`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Command registration ─────────────────────────────────────────────────

function registerLoopCommand(pi: ExtensionAPI): void {
	pi.registerCommand(LOOP_COMMAND, {
		description: LOOP_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: any) => {
			const trimmedArgs = (args ?? "").trim();

			// Stop request: /loop stop
			if (/^stop\b/i.test(trimmedArgs)) {
				if (activeLoop && activeLoop.active) {
					activeLoop.requestStop();
					ctx.ui.notify("Loop stop requested — will halt after current iteration", "info");
				} else {
					ctx.ui.notify("No active loop to stop", "warning");
				}
				return;
			}

			// Read-only / config subcommands.
			const saveMatch = /^save\s+(\S+)/i.exec(trimmedArgs);
			if (saveMatch) {
				await handleSave(saveMatch[1], ctx);
				return;
			}
			const loadMatch = /^(?:load|run)\s+(\S+)/i.exec(trimmedArgs);
			if (loadMatch) {
				await handleLoad(loadMatch[1], pi, ctx);
				return;
			}
			const deleteMatch = /^delete\s+(\S+)/i.exec(trimmedArgs);
			if (deleteMatch) {
				await handleDelete(deleteMatch[1], ctx);
				return;
			}
			const showMatch = /^show\b(.*)$/i.exec(trimmedArgs);
			if (showMatch) {
				await handleShow(ctx, showMatch[1].trim());
				return;
			}
			const logsMatch = /^logs\b(.*)$/i.exec(trimmedArgs);
			if (logsMatch) {
				await handleLogs(ctx, logsMatch[1].trim());
				return;
			}
			if (/^stats\b/i.test(trimmedArgs)) {
				await handleStats(ctx);
				return;
			}
			if (/^preview\b/i.test(trimmedArgs)) {
				await handlePreview(trimmedArgs.replace(/^preview\b/i, "").trim(), ctx);
				return;
			}
			if (/^resume\b/i.test(trimmedArgs)) {
				await handleResume(pi, ctx);
				return;
			}
			if (/^list\b/i.test(trimmedArgs)) {
				await handleList(ctx);
				return;
			}
			if (/^last\b/i.test(trimmedArgs)) {
				await handleLast(ctx);
				return;
			}

			// Bare /loop (no args) resumes the last config — matches Claude Code.
			if (trimmedArgs === "") {
				await handleResume(pi, ctx);
				return;
			}

			// Guard: only one loop at a time.
			if (activeLoop && activeLoop.active) {
				ctx.ui.notify("A loop is already running. Send /loop stop to cancel.", "warning");
				return;
			}

			const options = parseLoopArgs(trimmedArgs);
			if (!options.prompt) {
				ctx.ui.notify(LOOP_USAGE, "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish before starting a loop.", "warning");
				return;
			}

			await saveLastConfig(options); // enable /loop resume
			await runLoop(pi, options, ctx);
		},
	});
}

// ─── Extension factory ────────────────────────────────────────────────────

export default function piLoopExtension(pi: ExtensionAPI): void {
	if (typeof pi?.registerCommand !== "function") {
		console.error("pi-loop: pi.registerCommand unavailable");
		return;
	}
	registerLoopCommand(pi);
}
