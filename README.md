# Browser Agent For Brave

Local prototype for multipurpose browser automation with `Brave`.

This repo is meant to be general: browse real sites, fill forms, follow multi-step flows, and handle small desktop handoffs on Windows when a file dialog leaves the browser.

## What is inside

- `extension/`: MV3 extension for loading records, inspecting the current page, and running reusable profiles.
- `controller/`: direct control of Brave through Chrome DevTools Protocol plus Windows dialog helpers.
- `examples/`: different demos for forms, job applications, and a small game.
- `notes/`: short working notes and session memory.
- `AGENTS.md`: repo-level instructions for keeping lightweight context while solving tasks.

## Main idea

The project is built around two reusable pieces:

1. `records`: the data we want to use during automation.
2. `profiles`: declarative step sequences for a page or workflow.

The same engine can be reused for different tasks without rewriting the controller every time.

## Working memory inside the repo

To avoid losing context between steps or sessions, the repo includes:

- instructions in [AGENTS.md](AGENTS.md)
- a scratchpad template in [notes/session-memory.md](notes/session-memory.md)

The goal is to keep short notes such as:

- current objective
- immediate `todo`
- useful findings
- brief activity entries like `navigated to X`, `opened Y`, `updated Z`

## Supported record formats

- `JSON`: array of objects, single object, or `{ "records": [...] }`
- `TXT` or `CSV`: header-based tables
- `key: value` blocks separated by blank lines

Included examples:

- job application data: [examples/job-candidate-example.json](examples/job-candidate-example.json)
- game session data: [examples/game-session-example.json](examples/game-session-example.json)

## Supported step types

Profiles can mix:

- `waitForText`
- `waitForSelector`
- `clickText`
- `clickSelector`
- `fillByLabel`
- `fillSelector`
- `showNotice`
- `sleep`
- `repeat`
- `waitForWindow`
- `activateWindow`
- `sendKeys`
- `typeText`
- `navigateExplorer`
- `saveFile`

String values support templates like `{full_name}`, `{email}`, or `{vars.someValue}`.

## Load the extension in Brave

1. Open `brave://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `extension/` folder from this repo.
5. If you test local demos, enable `Allow access to file URLs`.

Included default profiles:

- `Generic visible form`
- `Job application form`
- `Clicker game demo`
- `Manual empty profile`

## Direct control from `controller/`

### Quick start with a local demo

By default it opens the job application demo:

```powershell
& ".\controller\start-brave-debug.ps1"
```

You can also open other demo pages:

```powershell
& ".\controller\start-brave-debug.ps1" -Page "examples\demo-form.html"
& ".\controller\start-brave-debug.ps1" -Page "examples\clicker-game-demo.html"
```

### Core browser commands

```powershell
node controller\brave-cdp.mjs version
node controller\brave-cdp.mjs list
node controller\brave-cdp.mjs snapshot
node controller\brave-cdp.mjs wait-text "Apply now"
node controller\brave-cdp.mjs wait-selector "form"
node controller\brave-cdp.mjs fill-label "Full name" "Ada Lovelace"
node controller\brave-cdp.mjs click-text "Collect coin"
```

### Windows dialog and Explorer control

When a workflow leaves the browser and opens a native window, there is a small Windows automation layer:

```powershell
node controller\windows-ui.mjs list
node controller\windows-ui.mjs wait-window "Guardar como"
node controller\windows-ui.mjs activate-window "Guardar como"
node controller\windows-ui.mjs type-text "C:\path\to\Downloads\main.zip" --title "Guardar como" --replace
node controller\windows-ui.mjs save-file "Guardar como" "C:\path\to\Downloads\main.zip"
node controller\windows-ui.mjs navigate-explorer "Explorador de archivos" "C:\path\to\Downloads"
```

### Run profiles in batch

Recommended:

```powershell
node controller\run-records.mjs <records> <profile>
```

Compatibility wrapper:

```powershell
node controller\fill-operations.mjs <records> <profile>
```

## Included examples

### 1. Job application

```powershell
& ".\controller\start-brave-debug.ps1" -Page "examples\job-application-demo.html"
node controller\run-records.mjs examples\job-candidate-example.json examples\job-application-profile.json
```

### 2. Game demo

```powershell
& ".\controller\start-brave-debug.ps1" -Page "examples\clicker-game-demo.html"
node controller\run-records.mjs examples\game-session-example.json examples\clicker-game-profile.json
```

## Limits

- The generic profile does not submit forms automatically by default.
- `showNotice` is useful for safe dry runs before final clicks.
- Logins, signatures, and sensitive confirmations should still be handled carefully.
- If a site changes, the profile may need a selector update.
- Windows steps depend on the correct window being in the foreground.
