# dsh-peak-valley-brake

[English](README.md) | [中文](README.zh.md)

A DeepSeek Harness plugin that stops dispatching requests while the API is billed at peak rates, resumes automatically when off-peak pricing returns, and never loses the work it withheld.

## The problem it solves

DeepSeek bills API calls by the clock ([official pricing page](https://api-docs.deepseek.com/quick_start/pricing), footnote 3):

| | Window (UTC) | Window (UTC+8) |
|---|---|---|
| **Peak** | `01:00–04:00` and `06:00–10:00`, Monday–Friday | `09:00–12:00` and `14:00–18:00`, workdays |
| **Off-peak** | every other hour, including all of Saturday and Sunday | every other hour |

Off-peak rates are half of peak rates. A coding agent left running through a peak window pays double for every request it makes in it.

## What it does

At the **step boundary** — the one moment where every tool the agent started has finished and no new request has been paid for — the brake refuses the next step. When off-peak pricing returns, it puts the withheld work back into the inbox and wakes the agent. Whenever it is not holding, the brake is completely transparent: it does not rewrite messages, does not inject anything, and does not change the request prefix.

```
off-peak            arm (peak − 5m)   peak (01:00–04:00 UTC)   release (peak end + 1m)
   │                      │                    │                        │
   │  steps enter freely  │  steps refused     │  steps refused         │  withheld work
   │                      │  work recorded     │                        │  re-delivered
```

### Why it refuses instead of cancelling

The loop executes a step's tools *after* that step's model request. A step boundary is therefore the only place where nothing is mid-flight: cancelling a turn (`agent.cancel`) would abort a tool that is part-way through writing a file. The plugin never calls `cancel`.

### Why a naive brake would destroy your prompt

This is the one non-obvious fact the whole design rests on, verified in `@deepseek-ai/dsh-agent-loop`:

```js
const claimed = this.inbox.claim(target, position.turn);       // messages leave the inbox here
const decision = await this.dispatch.waterfall("agent/pre-step", …);
if (decision.kind === "reject") return decision;               // …and are never put back
```

The loop claims a step's messages **before** it asks any plugin whether the step may enter, and a rejected step does not restore them. A brake that simply returns `reject` would silently delete the user's prompt from both the inbox and the session log.

So before refusing, this plugin copies the claimed batch into a durable ledger and keeps the verbatim message objects in memory. At the release instant it delivers them back — the first through `agent.send(…, 'next-turn', true)` so the driver actually wakes, the rest through `agent.inbox.append` to preserve order.

### It does not fight the auto-continue plugin

`dsh-client-auto-continue` re-sends "continue" after an interruption, and it runs inside the host process, so closing every browser tab does not stop it. It would be a real hazard for a brake whose refusal looked like an interruption. It is not one here, because its own documented rule is:

> **绝不自动继续**：用户主动停止(`aborted`)或策略拒绝(`blocked`)

A rejected step closes its turn with `reason: { kind: 'blocked' }`, which that plugin deliberately ignores. The brake therefore needs no coordination with it — but the interaction is a regression test, not an assumption.

## Install

Requires Node.js ≥ 20 and a DeepSeek Harness build whose `dsh plugin` command is available.

```sh
dsh plugin --profile web add link:D:\SoftDocument\DSHProject\PeakStopValleyStart
```

Restart the harness afterwards so the profile layer stack is rebuilt.

Uninstall:

```sh
dsh plugin --profile web remove dsh-peak-valley-brake
```

### One harness per `$DSH_HOME`

This is not a property of this plugin, but it governs how you test it, so it is recorded here.

**Only one harness may run against a given `$DSH_HOME` at a time.** Starting a second one against the same home fails during plugin-tree load:

```
failed to apply loader entry ui-task-board (@linxin666/dsh-client-ui-task-board):
  task-board ledger is already owned by process 13120
```

`@linxin666/dsh-client-ui-task-board` takes an exclusive process lock on `$DSH_HOME/task-board/ledger-v2.lock`, holding a PID and the owning process's start time. A second harness is refused the lock and the whole boot aborts. The lock is a deliberate protection, not an obstacle to route around: two harnesses sharing one task-board ledger would corrupt it. Deleting the lock file only moves the corruption risk to your task board.

This bites specifically when testing this plugin, because the plugin is installed *into a profile* and a profile is only re-assembled at boot — so you must restart a harness to load it, and the restart is exactly what the lock blocks while another instance is up. The trap is easy to fall into when the desktop app is running: **DSH Desktop's own harness runs `dsh … web`, and `web` is the profile you just installed into.** App and terminal therefore contend for one lock.

Two ways out:

1. **Restart the app instead of opening a terminal.** DSH Desktop loads the same profile, so the plugin appears there and no second instance is needed.
2. **Give the second instance its own home.** Then each harness owns its own lock:

   ```powershell
   $env:DSH_HOME = "$env:USERPROFILE\.dsh-web"
   dsh --profile web
   ```

   Note that a separate home has its own `settings.yaml`, so this plugin's `locale: auto` will re-derive the language there rather than inheriting your app's choice. Pin `locale: zh` or `locale: en` if that matters.

## Configuration

Add an `id`-targeted entry to the profile's `cordis.patch.yml` to change any of these. Every field has a default; no configuration is required.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. When off, the brake never holds. |
| `brakeLeadMinutes` | `5` | Arm this many minutes before a peak window opens. |
| `releaseDelayMinutes` | `1` | Hold this many minutes after a peak window closes. |
| `holdUserMessages` | `true` | Hold prompts you typed. Regenerable wakes (goal rounds, reminders) are always let go. |
| `verifyWorkspaceOnResume` | `true` | Check the workspace for external changes before re-delivering withheld work. |
| `allowManualOverride` | `true` | Permit the `/peak-valley` command to release held work early. |
| `announceOnBrake` | `true` | Post a receipt in the conversation when a request is withheld. |
| `locale` | `auto` | Language for operator-facing text: `auto`, `zh`, or `en`. |
| `releaseTickSeconds` | `30` | Re-evaluation period when the schedule table has no future boundary. |
| `home` | `$DSH_HOME` or `~/.dsh` | Where the hold ledger is written. |
| `peakWindowsOverride` | `''` | Escape hatch: replace the built-in window table. |
| `debug` | `false` | Also write guard decisions to stderr. |

```yaml
- id: peak-valley-brake
  config:
    brakeLeadMinutes: 10
    releaseDelayMinutes: 2
```

#### Configure it by `id`, never by `insert`

A row-shaped plugin already inserts its own entry through its bundle patch. Adding a second one fails the whole boot:

```
failed to apply loader entry peak-valley-brake (dsh-peak-valley-brake):
  duplicate loader entry id: peak-valley-brake
```

So the entry above is an **`id`-targeted override of the existing row**, not an instruction to add one. Writing it as `- insert: [{ id: …, name: … }]` looks equivalent and is not — the loader then inserts a second row with the same id and refuses the profile.

The failure mode is worth knowing about because the message names the plugin rather than the patch entry, which makes it look like a plugin defect on first reading.

### If DeepSeek changes the windows

The table is built in so the guard behaves predictably with no network — which leaves one risk: a schedule change makes the built-in table wrong until a new release ships. `peakWindowsOverride` closes that gap. It takes a JSON array of UTC minute-of-day windows, so an operator can react the same day:

```yaml
- id: peak-valley-brake
  config:
    peakWindowsOverride: '[{"weekdays":[1,2,3,4,5],"startMinute":60,"durationMinutes":180}]'
```

`weekdays` is 0=Sunday…6=Saturday, `startMinute` is a UTC minute of day (60 = 01:00), and `durationMinutes` must keep the window inside one UTC day. A malformed override is refused at load rather than ignored — an operator who has just learned the windows changed must not be left believing an override took effect when it did not.

### Workspace drift on release

A hold can last hours. If a human edits a file in that window, the agent's picture of the workspace — frozen in its session history — becomes wrong, and it would resume against a world that no longer matches what it last read. That is the failure mode this check exists for.

At hold time the brake fingerprints the workspace; at release it measures again and tells the model what moved:

```
[peak-valley-brake] The workspace changed while this request was withheld during peak
pricing. Do not rely on file contents you read earlier; re-read the affected files
before editing them.
- the set of modified and untracked files changed
Changed paths:
- src/parser.ts
```

The fingerprint is two facts, chosen because they are cheap and hard to fool:

1. **`HEAD`** — catches a branch switch or a commit made while held.
2. **`git status --porcelain --untracked-files=all`**, reduced to a digest — catches an edited, added, deleted, or newly created file, *including files the agent never touched*. This is the signal that matters, because the realistic case is a human editing code by hand during the peak window.

`.git/index`'s mtime is deliberately **not** part of it: running `git status` refreshes that file as a side effect, so two measurements of a pristine repository would disagree and the guard would cry drift on every release. A regression test asserts ten consecutive measurements agree.

Three properties are load-bearing:

- **Advisory, never blocking.** Drift annotates the work; it never withholds it. A guard whose job is to keep work moving must not become the reason work stalls.
- **"Unverified" is not "unchanged".** A workspace that is not a git repository, or a session with no working directory, reports that it could not be checked rather than implying nothing changed. A session with *no* workspace gets no notice at all — there are no files to go stale, and the warning would be noise on every delivery.
- **Paths only, never contents.** The ledger records repository-relative paths, never absolute paths and never file text.

Only relative paths enter the ledger, so a shared ledger cannot leak a directory layout.

### What drift detection cannot see

Because the signal is `git status`, it inherits that command's blind spots. Knowing them matters more than the feature's happy path:

- **A `.gitignore`d file is invisible.** Creating or editing one changes nothing in `git status`, so the guard reports `unchanged`. This is consistent — an ignored file is by definition one git does not track — but it is a real gap if a build step writes something you care about to an ignored path.
- **A file created *and* deleted during the hold is invisible**, because the net status is identical.
- **Changes outside the repository are invisible.** The check is scoped to the session's working directory; a sibling project edited in the same window is not reported.
- **A repository this session never had** reports `unverified` forever, and every release carries a re-read notice. That is honest but noisy, which is the argument for running the plugin's own repository as a repository — as this one now is.

In a real repository the check was verified end to end: creating one untracked file produced `drifted` with that path listed, while creating an ignored `.tmp` file produced `unchanged`.

### Seeing what the guard is doing

The host's own log is not visible in every launch mode, so the guard can report to the terminal that started the harness:

```sh
DSH_PEAK_VALLEY_BRAKE_DEBUG=1 dsh web
# [peak-valley-brake] armed; currently peak (brake lead 5m, release delay 1m)
```

That startup line is also the quickest way to confirm the plugin actually loaded.

### Seeing what was withheld, in the conversation

When the brake holds a request it posts a receipt into the transcript, so a hold never looks like a hang:

```
[peak-valley-brake] 当前 API 处于峰时计价，已拦截 2 条消息。
它们只是排队、并未丢失，将于 2026-09-15 12:01（UTC+8，即 2026-09-15 04:01 UTC）自动放行。
如需立即放行，请执行 /peak-valley 命令并传入参数 "now"。
```

It is injected as model-facing context rather than queued as a wake — a follow-up would wake the driver and be refused by this very brake. It carries `source.form: 'notice'`, so the harness renders it as a collapsed notice row rather than as speech from the operator, and its summary is bounded to the harness's 120-character limit.

It is posted **once per hold window**: a receipt per wake would turn a quiet wait into a wall of duplicate notices. `announceOnBrake: false` turns it off.

### Language

Every message a human reads — the receipt, the drift notice, the `/peak-valley` output — is served from a two-language dictionary. `locale: auto` resolves it in this order:

1. The harness's persisted UI language in `$DSH_HOME/settings.yaml`, when it has one. This is the real answer, because it is what the operator actually chose in the GUI.
2. `LC_ALL`/`LC_MESSAGES`/`LANG`/`LANGUAGE`, then the runtime's own ICU locale, then the Windows user default UI language from the registry. These are guesses at the UI language, which is why they rank below the setting.
3. English.

Set `locale: zh` or `locale: en` to pin it regardless of what the machine reports. Log lines are deliberately **not** translated and stay English: they are diagnostics read in a terminal, and a stable language keeps them greppable.

`test/locale.test.mjs` asserts the two dictionaries cover exactly the same keys at every nesting level, and that no Chinese entry is left holding untranslated ASCII — a missing translation would otherwise fail silently, mid-sentence.

### Releasing held work now: `/peak-valley`

Sometimes the work cannot wait for the valley. The `/peak-valley` command is the escape hatch:

| Invocation | Effect |
|---|---|
| `/peak-valley` or `/peak-valley status` | Current tariff, whether dispatch is held and why, the next schedule change, how much work is held here, and any live override |
| `/peak-valley now` | Release the held work **once**. The next message you send is withheld again |
| `/peak-valley window` | Keep dispatching until the next schedule boundary, so a normal back-and-forth works |
| `/peak-valley cancel` | Drop a live override; the schedule governs again |

**`now` and `window` are not the same command, and the difference bites.** `now` releases the queue once: it is the right choice for "get this one thing through". If you are mid-conversation, `window` is what you want, because `now` will withhold your very next message — and that reads as the command having failed. The hold receipt names both, for exactly that reason.

**Why a slash command and not a model tool:** the brake refuses a step *before* the model runs, so a tool the model could call is unreachable exactly when it is needed. Harness commands run straight against the agent with no model message and no token cost, which makes them the only entry point that still works while dispatch is held.

Three properties keep the override honest:

- **It expires by itself.** Both kinds run to the next schedule boundary — the guard cannot be left off indefinitely, and it re-arms without anyone remembering to switch it back on.
- **It is auditable.** Every release that the schedule would have held is appended to `overrides.ndjson` in the plugin's data directory: which session asked, when it was granted, when it was spent, and how the tariff was classified at that moment. Skipping cost policy is the operator's call to make, not one to make invisibly. The record goes to an append-only file rather than the per-session ledger, because the ledger is deleted by the very delivery the record describes.
- **It is refusable.** `allowManualOverride: false` makes the command return an error rather than obey, so an operator can guarantee that no command overrides their cost policy.

An override never survives a restart: it is process-local state, because the whole point of a brake is that it re-arms by itself.

## The badge

The plugin also puts a badge in the corner of the Web UI: a character whose pose is the guard's state, with the same operations the slash command offers behind a hover toolbar.

| Pose | Meaning |
|---|---|
| `idle` | off-peak, nothing withheld |
| `armed` | inside the pre-peak brace; the brake is about to engage |
| `held` | peak, work is being withheld |
| `released` | work has just been delivered |

Hover the character and the toolbar appears: status, release once, release until the valley, cancel the override. Each button runs the same handler as its subcommand, so a button and the command line cannot describe one operation two ways — the answer is printed in the bubble, in the command's own words. Drag the character to move it, click it to toggle the bubble; both are remembered per browser.

A live override is shown even when nothing is held. It is the one state that spends money at peak deliberately, so the badge refuses to be quiet about it.

The character breathes and casts a ground shadow, and carries a glass bead — a halo, a translucent shell, a bright core and a pinprick of glare — whose **halo radius is the state's intensity**. Quiet states cost no attention, and the one state that actually spends money is the only one that shouts. The bead's colours are system status colours rather than theme tokens, deliberately: a status colour that shifted with the theme would stop being a signal. Everything else takes its surface from the theme.

The panel above the character is a small dashboard rather than a sentence: a titled header with a LIVE pill, a hairline, then six rows — the tariff, the dispatch decision, the next schedule change, the release instant, how much is held, and whether an override is live. Each is answered from the live state, which the host composes on demand rather than reading back from what it has announced: `publishedStates` only holds what the brake has already said, and it says nothing until a message has actually been held, so a reader that trusted it answered an ordinary off-peak session with nothing at all and the panel came up blank.

The next change is published because only the host can answer it — the browser has no window table and no clock the host would agree with. It is read from `boundariesAround`, whose field is `instantMs`; this plugin's first version read a `transitionMs` that exists only in a stale doc comment, so that row silently showed nothing.

**The bead and the panel's mark answer different questions, and the design draws both.** The bead says what the *badge* is doing — grey when that is nothing, blue while it holds, red only when an override is spending money on purpose — with its halo radius carrying the intensity. The panel's tariff mark says what the *tariff* is, where off-peak is green because cheap is the good state. One shared colour would have made "cheap" and "nothing happening" look identical.

The panel's *own* colour is neither of those: the header dot and the LIVE pill are brand blue in every state, because the design fixes them. Deriving them from the state accent made the whole header grey whenever the tariff was off-peak, which reads as "something is wrong" rather than as "everything is cheap". Three axes, three answers, and each one is asserted. The header mark is a solid dot inside a soft halo rather than one blurred dot — at 10px there is no room to be both lit and legible.

The panel is a **notification, not a fixture**: it appears when something happens, and it closes itself after `panelAutoHideMs` — five seconds by default, zero meaning "leave it up until I dismiss it", and editable on the plugin's settings page. One rule for every panel, whether the operator asked for it or a hold produced it.

An earlier version exempted the hold-reporting kind, on the reasoning that it explains a situation and should not vanish while the situation holds. That was wrong in the only way that mattered: a situation lasts as long as the peak window does, so the panel sat on screen for over an hour and had to be clicked away. The countdown is armed on the *transition* into visibility, never on every render, because the host polls every couple of seconds and re-arming there would restart it forever.

A dismissal is likewise scoped **to the situation being dismissed**, not to the session. Dismissals are stored with a signature of what was on screen — the gate, the tariff, any override, how much is held, when the last release was — and lapse when that signature changes, so the next withheld message brings the panel back. That signature deliberately excludes the host's `updatedAtMs`, which moves on every poll; including it would make every poll look like news and the panel would return immediately after each dismissal. Before this, nothing ever cleared the flag, so the first click on the character silenced the badge for the rest of the session.

The bar below is a pill of four tabs, each an icon above its label. The selected tab is *lighter* than the bar it sits in rather than tinted, as the design draws it, and the one it marks is the status tab — which is also the only operation that can never be unavailable. **The panel *is* the status**, so that tab pins the panel open rather than asking the host for a paragraph about the same facts; the mark travels as `aria-pressed` and is tied to whether the panel is actually open, so highlighting it states a fact rather than decorating a button. The other three still ask the host and show its answer, because a confirmation or a refusal is prose. An unavailable operation is dimmed rather than removed, because the bar doubles as the explanation of the current state.

**Structure is inline; the stylesheet is decoration only.** This project cannot observe whether an injected sheet is applied in the operator's browser, so anything the badge's *shape* depends on is an inline style — the one mechanism the geometry already trusts. A row that is a row only because a class said `display: flex` becomes three stacked blocks the day the sheet does not apply, which is precisely what happened to the panel's label/value alignment. What is left in the injected `<style>` is what inline styles genuinely cannot express: keyframes, `:hover`/`:focus-visible`/`[aria-pressed]`, `backdrop-filter` with its prefixed twin, and one `prefers-reduced-motion` block. A case mounts into a document that refuses `<style>` outright and asserts the panel is still a panel.

The sheet also marks itself with `data-plugin`, because the loader tags every unclaimed `<style>` it finds with the id of whichever client plugin materializes next and removes a plugin's styles when that plugin unloads — an unmarked sheet is one unrelated plugin reload away from silently disappearing.

The glass surface is mixed from theme tokens with `color-mix`, so one rule frosts over a light page and a dark one; where `color-mix` is unsupported the declaration is dropped and the panel is plainer but working. An earlier version styled itself with invented token names — `--dsw-surface` and friends, none of which exist — and became a white box on a dark theme with no symptom anywhere; an assertion now fails on any `var(--…)` that is not a real token.

### Why the browser asks the host

Reading the `peakValleyBrake` projection in the browser is the obvious design, and it cannot work. The client half of this harness provides `connection`, `locale`, `theme`, `chatFileMentions`, `sessionLogDownload` and the cordis runner's own pair — and no session registry and no projection registry. A client plugin that declares a service nobody provides is parked until it appears, so it never activates: the badge simply never mounts, and nothing anywhere reports an error.

So the state travels over `POST /api/peak-valley-brake.action`, which the host can answer because the host owns both services and is the only side that knows which session the operator is looking at. The badge's first poll names no session; the host answers with one, and the badge sends it back from then on. Every answer carries the current state, so acting and refreshing are one round trip rather than two.

### Why the badge sits behind the same fence

The route is claimed under `/api`, which this harness gives to exactly one owner: that owner authenticates the browser and validates `Host`/`Origin` before dispatching to registered exact paths. A badge route registered anywhere else would stand outside that fence, and an unclaimed path under `/api` returns 404 rather than falling through to another owner. The action vocabulary is closed — `poll`, `status`, `now`, `window`, `cancel` — so a malformed or hostile request cannot reach the command handler with arbitrary input.

### The settings page

Settings → 峰谷刹车 holds three preferences: whether the character is shown, how tall it is, and how long the toolbar lingers after the pointer leaves. They live in the harness's own settings plane — `$DSH_HOME/settings.yaml`, namespace `peak-valley-brake` — which is what gives each field a restore-default and lets the choices follow you to another machine.

The page occupies the `settings.section` slot, so it sits in the nav beside the shipped sections and mounts only while it is selected. That slot is declared by the settings shell while *it* mounts rather than by a package, so it has to be reached through `slots.inject`; a bare `register` would find no such slot. Occupants must be React components, so the page is built with the host's own React — the build marks React external, because a second bundled copy would give the page two React instances and every hook would throw.

Two things are deliberately optional rather than required. `slots` and `settingsScope` are declared nullish, and cordis skips a nullish inject entry entirely (`if (isNullable(config)) continue`), so a deployment with no settings surface still mounts the badge instead of parking the plugin forever. And the schema declares no `min`/`max`: schemastery *rejects* an out-of-range value while the settings service resolves the whole namespace at registration, so a hand-edited `settings.yaml` could otherwise take the brake down over a cosmetic preference. The ranges are enforced where the values are used instead.

## Writing a plugin that loads in this harness

Three contracts cost real debugging time to discover, and all three fail with messages that do not name the cause. They are recorded here because any plugin in this ecosystem hits them. Each is asserted in `test/manifest.test.mjs`, so a future edit cannot silently reintroduce them.

**1. `Config` must implement Standard Schema, not be a plain object.** cordis resolves configuration by calling `Config['~standard'].validate(raw)`. A plain object descriptor produces:

```
failed to apply loader entry <id>: Cannot read properties of undefined (reading 'validate')
```

A zod object schema satisfies this directly, which is why `Config` is one here.

**2. A row with no `config:` key validates `undefined`.** An object schema alone rejects that with `expected object, received undefined`, which would make the plugin impossible to install without also configuring it. `.default({})` looks like the fix but is not: it substitutes *after* validation and hands back a hollow `{}` with no field defaults applied. `prefault({})` substitutes *before* validation, so the field defaults still run. The exported shape is therefore `ConfigShape.prefault({})`.

**3. Every service you read must be declared in `inject`, even when it is optional.** Reading an undeclared service throws:

```
failed to apply loader entry <id>: cannot get property "commands" without inject
```

Checking `if (ctx.commands === undefined)` does not help — the throw happens on the property read. But declaring the dependency as *required* makes the plugin unloadable in any composition that lacks it, which is worse for a plugin that must also run headless. cordis treats a **nullish inject value as optional** (`if (isNullable(config)) continue`), so the correct form is:

```js
export const inject = { commands: null };
```

…and then read it defensively, because an optional service can still be unavailable in an inactive context:

```js
const probeCommands = () => {
  try { return ctx.commands } catch { return undefined }
}
```

### Why there is a lead and a delay

A request is billed at the rate in force when it is **processed**, not when it is sent. A request started at `11:59` that returns at `12:00` is billed at peak. The 5-minute lead stops the brake from being defeated by that race, and the 1-minute delay stops it from releasing into it. Raise the lead if your requests routinely take longer than five minutes.

## What it will not do

- **It is not zero-cost during peak.** The brake is installed on root agents and does not govern subagents, background jobs, or workflows already in flight. Work already dispatched when peak begins runs to completion and is billed at peak. The guarantee is *no new requests at peak*, not *no spend at peak*.
- **It does not shut the harness down.** No process management, no scheduled tasks. The host must be running for the automatic resume to happen.
- **Prompts withheld across a host restart come back as a summary, not verbatim.** The ledger survives the restart; the exact message objects do not. A reconstruction is delivered, clearly labelled as one. Within a single process lifetime, the original text is preserved exactly.
- **The schedule table is built in.** It was checked against the official page on 2026-09-15. If DeepSeek changes the windows, this plugin needs a release — it does not scrape the page, deliberately, so its behaviour is fully predictable offline.
- **A withheld prompt is not visible in the chat while it waits.** It is recorded and re-delivered, but the conversation shows nothing until release. Check the plugin log line, which names the release instant.

## Fail-open guarantee

A cost guard must never be the reason work stops. Every degraded path allows the step instead of refusing it:

| Fault | Behaviour |
|---|---|
| The ledger cannot be written | The step enters; the reason is logged. Refusing would destroy a prompt that could not be preserved. |
| The ledger cannot be read at release | Nothing is delivered this pass; the batch stays on disk for the next attempt. |
| A re-delivery throws | The ledger is **not** cleared, so the batch is retried at the next release pass. |
| The plugin throws while installing listeners | The agent is left unguarded and the failure is logged. |

## Verifying it

```sh
node test/time-window.test.mjs      # window arithmetic: edges, weekend, Monday boundary, braces
node test/locale.test.mjs           # dictionary parity and language resolution
node test/workspace-drift.test.mjs  # drift detection against real temporary git repositories
node test/hold-ledger.test.mjs      # durability, corruption, concurrent writes
node test/brake.test.mjs            # host integration: hold, release, order, restart, drift, fail-open
node test/manifest.test.mjs         # assembly: manifest ↔ patch ↔ module agreement
node test/readme.test.mjs           # README.md and README.zh.md stay structurally in step
```

381 assertions, no test framework and no dependencies. The suites are deterministic: the schedule tests assert against explicit UTC instants, the integration tests inject a fixed clock *and* a fixed language, and the drift tests build real repositories in the OS temp directory with an explicit committer identity.

They also need no harness running, so they sidestep the one-harness-per-`$DSH_HOME` constraint entirely — `npm test` is the fast way to check the plugin without touching a live profile.

## File layout

```
dsh-peak-valley-brake
├── package.json           # dsh.bundle.patch and dsh.client declarations
├── cordis.patch.yml       # the plugin row inserted into a profile
├── lib/
│   ├── time-window.js     # pure schedule arithmetic; no I/O, no ambient clock
│   ├── messages.js        # the zh/en dictionaries
│   ├── locale.js          # language resolution
│   ├── hold-ledger.js     # durable record of withheld work
│   ├── workspace-drift.js # workspace fingerprinting and drift reporting
│   ├── hold-state.js      # the session event and projection a client reads
│   ├── badge-view.js      # pure badge decisions: pose, bubble, toolbar
│   ├── badge-mount.js     # the badge as DOM, a function of its dependencies
│   ├── badge-api.js       # the host route the toolbar buttons call
│   ├── client.js          # client entry: polls the host, mounts the badge
│   ├── client.bundle.js   # built, committed, served to the browser
│   ├── mascot-data.js     # generated art, inlined as data URIs
│   └── index.js           # the brake: pre-step guard, release scheduler, re-delivery
├── assets/mascot/         # character art per state, plus generated derivatives
├── scripts/               # art generation and the client bundle build
└── test/                  # thirteen self-checking suites
```

`lib/time-window.js` is deliberately pure: it takes an instant and returns a classification, reading no clock and performing no I/O. That is what makes "why was this request held?" answerable by recomputation rather than by trusting a log.

## Limitations and known risks

- Subagents in flight at the peak boundary are billed at peak (see above).
- The brake governs root agents created after the plugin loads; an agent that predates a hot reload is not adopted.
- Work that only exists in the inbox — a goal round a driver would re-issue — is intentionally released rather than held, because holding it would race the driver that regenerates it.
- The release timer is a single shared timer, re-armed from the current clock at every boundary rather than accumulated, so a system clock change shifts the answer instead of corrupting it.
- Drift detection needs git. In a workspace that is not a repository it reports "could not be checked" instead of guessing, so the model is told to re-read rather than told a change happened.
- The hold receipt is injected as model-facing context (`source.form: 'notice'`), so it appears in the transcript as a collapsed notice rather than as a chat message. Its rendering has been verified against the harness message types and against the shape an in-box plugin already uses, but not yet observed in a live conversation.
- The badge's appearance has not been observed by this project. Its composition into the real boot graph, the loader contract it satisfies, and its behaviour against a fake document are all asserted; what it looks like in a browser is checked by a human.
- The badge polls. A push channel would need a client-side subscription the client half does not offer, so it costs one small authenticated request every few seconds while a page is open.

## Development

The suite needs no harness, no network, and no API credit — it is the fastest way to check a change without touching a live profile. `npm test` runs all thirteen files; each also runs on its own, which is what you want while iterating.

### The pre-push gate

`npm test` runs automatically before every push, and a failure refuses the push:

```
pre-push: running the test suite (SKIP_TESTS=1 to bypass)...
pre-push: suite passed
```

It runs the **whole** suite rather than guessing which tests a change affects. Seven independent files take under a minute, and a gate that decides which tests matter is a gate with a hole in it. The cost of running everything is paid once per push; the cost of skipping the one test that mattered is paid by whoever pulls.

Committing a hook requires one setup step per clone, because `core.hooksPath` is local git configuration and a clone does not carry it:

```sh
npm run hooks:setup
```

That points `core.hooksPath` at the committed `.githooks/` directory and marks the hooks executable. Without it the directory is inert — git keeps looking in `.git/hooks`, where nothing is committed and therefore nothing reaches anyone else.

To bypass in a genuine emergency:

```sh
SKIP_TESTS=1 git push
```

It is deliberately spelled out rather than wired to `git push --no-verify`, which would also bypass hooks you may want later.

`.githooks/**` is pinned to LF in `.gitattributes`. A CRLF shebang makes Git Bash look for an interpreter named `/bin/sh\r`, and the hook dies with `bad interpreter` — a failure that looks like a broken repository rather than a line-ending problem.

### The mascot art

The badge's character art lives in `assets/mascot/`. The sources there are the full-size originals; the numbered subdirectories (`128/`, `200/`, `320/`) are generated derivatives at the heights the badge actually renders, one per state:

| File | State it depicts |
|---|---|
| `idle.png` | off-peak, nothing withheld |
| `armed.png` | inside the pre-peak brace |
| `held.png` | peak, work is being withheld |
| `released.png` | work has just been released |

Regenerate the derivatives after changing any source:

```sh
pwsh -File scripts/resize-mascot.ps1
```

It uses `System.Drawing` rather than `sharp`, deliberately: `sharp` ships inside the desktop app's `node_modules` but is built for Electron's Node ABI, so it does not load under a plain system Node. The script writes 32-bit ARGB, so the cut-out backgrounds stay transparent — a flattened background would show as a coloured box behind the badge.

`test/assets.test.mjs` asserts that every state has art at every size, that each file is a real PNG within a size ceiling, and that the art directory and the state list agree. Those assertions exist because a missing file is not a failing test in a browser — it is a silently blank badge, which is precisely what this project cannot observe by itself.

## License

MIT
