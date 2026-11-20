# OpenCode Code Mode: adding file tools and measuring the gain

Date: 2026-11-19 · OpenCode v2.2.7 · Model: Claude Opus 5.5

## Abstract (for Slack)

OpenCode's Code Mode (`execute`) lets the model write one JavaScript script that calls many tools and returns only a summary, much like Claude Code's new experimental Code Mode. Unlike Claude's version, it couldn't reach the core file tools, so we built a small OpenCode plugin (`codemode-fs`). It adds `tools.fs.read/glob/grep/edit` to Code Mode, leaves the built-in tools untouched, and applies the same permission rules. On a search and replace across 124 CSV files (30 MB, 89 matches in 12 files), the Code Mode run was **about 7× cheaper ($0.08 vs $0.57)**, used **about 9× fewer context tokens**, and finished **about 30% faster (37 s vs 52 s)**, with identical correct results. The trade-off: the model sees less raw output, so it can miss side effects that the direct run pointed out. That makes Code Mode best for bulk work where the expected output is clear.

## Status

| Item | State |
|---|---|
| Idea A (move built-ins into Code Mode) | Works, but removes the built-ins from the direct tool list. **Disabled** (`disabled-plugins/codemode-builtins/`) |
| Idea B (`fs` wrapper tools) | **Active globally**. Code in `plugins/codemode-fs/index.ts`, loaded from `~/.config/opencode/opencode.jsonc` |
| Permission enforcement for B | Verified (deny rules block `fs.read` and `fs.edit`) |
| Benchmark | Done, 1 run each (see below) |

## Files

```
C:\GIT\topomorph\opencode\
├─ PLAN-codemode.md                       this document
├─ plugins\codemode-fs\index.ts            idea B plugin (global; NOT under .opencode so it isn't loaded twice)
├─ disabled-plugins\codemode-builtins\     idea A plugin (inactive)
└─ testbed\
   ├─ opencode.jsonc                       deny rules: read secret/*, edit locked.txt
   ├─ src\a.ts, src\b.ts, secret\key.txt, locked.txt   permission fixtures
   ├─ clean_csv\                           benchmark data (124 CSVs, 29.6 MB; throwaway)
   └─ clean_csv.bak\                       pristine copy for resetting between runs
```

Benchmark helpers (outside the repo): `%LOCALAPPDATA%\Temp\opencode\summarize.ps1`, and the raw logs `run1.jsonl` (Code Mode) and `run2.jsonl` (direct).

---

## 1. Background Q&A

### Q1. How does OpenCode compare with Claude's new experimental "Code Mode"?

Same core idea. The model writes JavaScript that calls several tools in one step, the harness runs it, and only the returned value goes back into context. Benefits: chained calls, parallel calls (`Promise.all`), local filtering of noisy output, and fewer model round trips. The idea comes from Cloudflare's "Code Mode", built mainly for MCP.

| | OpenCode V2 | Claude Code Code Mode |
|---|---|---|
| Entry tool | `execute` | `REPL` |
| Tools reachable from code | Catalog only: MCP servers (unless `codemode: false`), `opencode` namespace (sessions, worktrees, models), `browser`, plugin tools with `codemode: true`. Core tools (read/grep/edit/shell) are direct calls | Core tools (Bash, Read, Edit) plus MCP. Shell helper `` await $`rg ...`.text() `` |
| Discovery | `search()` finds tools on demand → smaller upfront context | Tools listed up front |
| Runtime | Confined: no imports, no filesystem, no timers. Has `fetch` | Runs in the session. JS plus its file, web and MCP calls run outside the Bash sandbox |
| Permissions | Nested built-in and MCP tools enforce their own rules. Plugin tools enforce only the permissions they assert | Deny/ask rules and PreToolUse hooks run per inner call. A hook on `REPL` can read `tool_input.code` |
| Status | Built in. Disable with a deny rule on `execute` | Experimental: `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` (v2.1.323+) |

### Q2. What does Claude's version have that could improve OpenCode's?

Biggest gap: **core tools callable from code** (grep → read → edit in one script). Smaller ones:

- Shell helper syntax.
- Hook that reviews the whole script before it runs.
- "Approve each script first" mode.
- Permission prompt in the middle of a script, then the script resumes.
- Output redaction hooks.
- Long-running scripts with a stop control.
- Ctrl+O view of the JS that ran.

What OpenCode does better (keep): lazy `search()` discovery, and the confined runtime.

### Q3. How do we add this?

With a **server plugin**. `ctx.tool.transform` can add or update tools with `options: { codemode: true }`, which puts them in the `execute` catalog.

- **A.** Update the built-ins to `codemode: true`. Little code.
- **B.** Wrapper tools in a custom namespace. Full control, built-ins untouched, but every executor must call `ctx.permission.assert` itself.

### Q4. Should every tool be added to Code Mode?

No. Code Mode wins when there are **many calls and a small answer**. It loses on single calls: the extra script, `JSON.parse`, less visibility, and duplicate tools that confuse the model.

| Tool | Add? | Why |
|---|---|---|
| `write` | Yes | Low risk, same `edit` permission, useful for bulk file creation |
| `shell` | Maybe, read-only allowlist only | A wrapper loses the built-in command scanner |
| `webfetch` | No | `execute` already has `fetch` |
| `websearch` | No | Rarely run in bulk |
| `question`, `skill`, `subagent` | No | Interactive, or they change the conversation |

---

## 2. Idea A: move built-ins into Code Mode (disabled)

Plugin: `disabled-plugins/codemode-builtins/index.ts`. It runs `editor.update(id, t => t.options = { ...t.options, codemode: true })` for `read`, `grep` and `glob`.

Results:
- `search()` returned `tools.read`, `tools.grep`, `tools.glob`. ✅
- One `execute` call chained `tools.glob` → `tools.read` and got **structured objects** back (built-ins return objects, unlike plugin tools). ✅
- **Side effect:** the tools are **removed from the direct list**, so every single read has to go through `execute`. This is why A was dropped in favor of B.
- Quirk: `read` labels `.ts` files as mime `video/mp2t` (the content is correct). Possibly an upstream bug.

## 3. Idea B: `fs` wrapper tools (active)

### Implementation

`plugins/codemode-fs/index.ts` registers the `fs` namespace with `options: { namespace: "fs", codemode: true }`. It is loaded for **every project** through the global config:

```jsonc
// C:\Users\brogers\.config\opencode\opencode.jsonc
"plugins": [ ..., "C:/GIT/topomorph/opencode/plugins/codemode-fs" ]
```

To turn it off for one project, add `"plugins": ["-codemode-fs"]` to that project's `opencode.jsonc`. Paths inside the session folder are returned relative to it, and paths outside it are returned absolute.

The tools:

| Tool | Returns (JSON string) | Permission asserted |
|---|---|---|
| `fs.read({ path, offset?, limit? })` | `{ path, content, startLine, endLine, totalLines, next }` | `read` on the path |
| `fs.glob({ pattern, path?, hidden?, limit? })` | `["rel/path", ...]` (default limit 200) | `glob` on the pattern |
| `fs.grep({ pattern, path?, include?, literal?, caseSensitive?, limit? })` | `[{ path, line, text }]` (default limit 100) | `grep` on the pattern |
| `fs.edit({ path, oldString, newString, replaceAll? })` | `{ path, replacements }` | `edit` on the path |

Details:
- **Permission resources match the built-ins** (location-relative path inside the project, absolute path outside, plus an `external_directory` check for outside paths), so existing rules apply unchanged.
- Pure Node (`rg` isn't installed): a recursive directory walk plus a small glob-to-regex converter. Skips `.git`, `node_modules`, `.hg`, `.svn`, dotfiles (unless `hidden`), files containing NUL bytes (treated as binary), and files over **50 MiB** (raised from 2 MiB for the benchmark).
- `fs.edit` errors if the text is missing or matches more than once without `replaceAll`, and it doesn't run a formatter.
- Cancellation: the walker checks `context.signal`.

Usage in `execute`:

```js
const P = async (p) => JSON.parse(await p)
const hits = await P(tools.fs.grep({ pattern: "retryPolicy", include: "**/*.ts" }))
const files = await Promise.all([...new Set(hits.map(h => h.path))].map(p => P(tools.fs.read({ path: p }))))
await P(tools.fs.edit({ path: "src/a.ts", oldString: "maxAttempts: 3", newString: "maxAttempts: 5" }))
return files.map(f => `${f.path}: ${f.totalLines} lines`)
```

### Functional and permission tests (`testbed/`)

| Check | Result |
|---|---|
| `search({ namespace: "fs" })` lists `fs.read/glob/grep/edit` | ✅ |
| Built-in `read/grep/glob/edit` still direct, and no plain `tools.read` in the catalog | ✅ |
| grep → parallel reads → edit → re-read in one `execute` | ✅ |
| `fs.read secret/key.txt` (deny `read secret/*`) | ✅ `Permission denied: read` |
| `fs.edit locked.txt` (deny `edit locked.txt`) | ✅ `Permission denied: edit` |
| Read outside the project (`..\..\Windows\win.ini`) | Allowed, same as the built-ins (default `external_directory` allow) |
| Plugin loads in subfolders (`testbed/`) | ✅ (ancestor `.opencode/plugins` load) |
| Manual test in the TUI ("change bedrock in logs using execute and tools.fs") | ✅ only `fs.*` calls, all nested under `execute` |

## 4. Benchmark: Code Mode (`fs.*`) vs direct tools

**Data:** `testbed/clean_csv`, 124 CSV files, 29.6 MB (largest 2.6 MB).
**Task (same prompt both runs):** find case-sensitive `Tools panel` across all files, report the file count, total and top 3 files, replace every match with `All tools panel`, and verify none remain. Shell banned in both. Run 1 told to use `execute` + `tools.fs`. Run 2 told to use direct tools only, with the plugin moved out.
**Ground truth** (counted with PowerShell): 89 matches in 12 files.
**Method:** `opencode run --auto --format json`, tokens and cost summed from the `step_finish` events, files restored from `clean_csv.bak` between runs.

| | Code Mode (`fs.*`) | Direct tools | Ratio |
|---|---|---|---|
| Model steps | 4 | 9 | 2.3× |
| Tool calls | 2 `execute` (+1 skill) | 25 (2 glob, 10 grep, 12 edit, 1 skill) | 12× |
| Output tokens | 1,220 | 4,145 | 3.4× |
| Cache read tokens | 40,965 | 382,244 | 9.3× |
| Cache write tokens | 8,394 | 76,587 | 9.1× |
| Cost | **$0.079** | **$0.565** | **7.1×** |
| Wall time | **37 s** | **52 s** | 1.4× |
| Correct (89 matches in 12 files, 0 left) | ✅ | ✅ | |

Both runs found the same top 3 files: InDesign desktop (41), Premiere Elements desktop (14), Animate desktop (8).

**Why:** in the direct run, every grep result and edit sits in context and is re-sent on each of the 9 steps (cache read 382k). In Code Mode, the raw results stay inside the script and only a summary comes back.

**Quality trade-off:** the direct run saw every matching line and reported side effects: the existing text `All Tools panel` became `All All tools panel`, and other products' "Tools panel" text was renamed too. The Code Mode run made the same changes but never saw those lines, so it reported nothing. Mitigation: when side effects matter, have the script return the odd-looking matches (e.g. the text around each hit, or matches preceded by "All ").

**Caveats:** 1 run each, 1 model, 1 task type (bulk search and replace). The `skill` call in both runs comes from a session-start hook, not the task.

## 5. Limitations

1. **Plugin tools return text only.** `Tool.Content` is text or file, and extra fields (`structured`, `output`) are ignored (tested), so scripts must call `JSON.parse`. Built-ins return objects.
2. No `fs.write` or `fs.shell` yet.
3. Search ignores `.gitignore` and is slower than `rg` on big repos.
4. Silent gaps in `fs.grep`: skipped files (binary, UTF-16, over 50 MiB) and cut-off results (`limit` reached) aren't reported.
5. Less visibility: the user sees one `execute` row, and the model sees only what the script returns.

## 6. Next steps

1. **Repeat the benchmark** (3+ runs per mode) and add a read-and-summarize task and a small single-file task, to find where Code Mode stops paying off.
2. **Make `fs.grep` report skipped files and cut-off results**: return `{ hits, truncated, skipped: [{ path, reason }] }`, and detect UTF-16.
3. **Add `fs.write`** (asserting `edit`). Consider a read-only `fs.shell` with an allowlist (`git status *`, `git diff *`, test commands).
4. **Upstream asks (OpenCode):** structured return values for plugin tools in Code Mode, and a way to list a tool both directly and in Code Mode (which would make idea A viable).
5. **Visibility and review:** a `ctx.tool.hook("execute.before")` to log or review `execute` code (like Claude's `REPL` hook), and optionally `ctx.permission.hook("evaluate")` to review `fs.edit`.
6. Use `rg` when it's installed, and respect `.gitignore`.
7. **Rollout:** ✅ global via `~/.config/opencode/opencode.jsonc`. Still to do: publish as an npm or git package for the team (`opencode plugin add github:...`).
8. Report the `read` mime quirk (`.ts` → `video/mp2t`) if it reproduces.

## 7. How to reproduce the benchmark

```powershell
cd C:\GIT\topomorph\opencode\testbed
# reset data
Remove-Item clean_csv -Recurse -Force; Copy-Item clean_csv.bak clean_csv -Recurse
# Code Mode run (plugin loaded globally)
opencode run --auto --format json "<task prompt> Do not use the shell tool. Use execute with tools.fs for all file work." > run1.jsonl
# reset data, disable the plugin for this folder (add "plugins": ["-codemode-fs"] to testbed\opencode.jsonc), then the direct run
opencode run --auto --format json "<task prompt> Do not use the shell tool or execute. Use the direct file tools (grep, glob, read, edit)." > run2.jsonl
# summarize (steps, tool calls, tokens, cost, time)
& $env:LOCALAPPDATA\Temp\opencode\summarize.ps1 run1.jsonl
```

Task prompt: *In the clean_csv folder, find every occurrence of the exact, case-sensitive text 'Tools panel' across all files. Report how many files contain it, the total number of occurrences, and the top 3 files by count. Then replace every occurrence with 'All tools panel' in every file and verify none remain.*

Remember to remove the `-codemode-fs` entry afterwards.

---

## 8. Video script (~3 minutes)

*Spoken: about 430 words at a normal pace. [Brackets] = what's on screen.*

**0:00 – Hook (15 s)**
[Title card: "Code Mode: 7× cheaper file work in OpenCode"]
"An AI agent fixing a word in a dozen files usually makes twenty-five separate tool calls, and each one re-sends the whole conversation. We made that same job seven times cheaper. Here's how."

**0:15 – The idea (35 s)**
[Diagram: model → tool → model → tool…, then model → one script → many tools → summary]
"Normally an agent calls a tool, reads the result, thinks, and calls the next one. Every step adds to the context it pays for. Code Mode flips that: the model writes one small JavaScript script that calls many tools, filters the results, and hands back only a short summary. Claude Code just shipped this as an experimental feature. OpenCode already has it, through its `execute` tool."

**0:50 – The gap (25 s)**
[Screen: Code Mode catalog showing only `opencode` and MCP namespaces]
"But in OpenCode, Code Mode could only reach MCP servers and admin tools, not the everyday file tools: read, grep, glob, edit. So the jobs that would benefit most couldn't use it."

**1:15 – The fix (35 s)**
[Editor: `plugins/codemode-fs/index.ts`, then highlight `codemode: true` and `ctx.permission.assert`]
"So we wrote a small OpenCode plugin. It adds four tools under an `fs` namespace that only Code Mode can see. The built-in tools stay exactly as they were. Each new tool runs the same permission checks as the built-ins, so if a rule blocks reading a secrets folder, the script is blocked too."
[Show the two denied results: `Permission denied: read`, `Permission denied: edit`]

**1:50 – The benchmark (45 s)**
[Folder of 124 CSVs, 30 MB → task prompt]
"The test: 124 CSV files, thirty megabytes. Find every 'Tools panel', report the counts, replace it, and verify. Same model, same prompt, run once each way."
[Results table animates in]
"Direct tools: nine model steps, twenty-five tool calls, fifty-two seconds, fifty-seven cents. Code Mode: four steps, two script calls, thirty-seven seconds, eight cents. Both got all eighty-nine matches in twelve files right. That's seven times cheaper, nine times less context, and about thirty percent faster."

**2:35 – The catch (15 s)**
[Highlight "All All tools panel"]
"There's a trade-off. The direct run saw every matching line, so it noticed that 'All Tools panel' had become 'All All tools panel'. The script never showed those lines, so the Code Mode run missed it. When side effects matter, have the script return the odd-looking matches too."

**2:50 – Close (10 s)**
[Global config line, then the plan doc]
"It's now on for every project through one line in the global config. The full write-up and the steps to reproduce the test are in the plan doc. Give it a try on your next bulk change."
[End card]
