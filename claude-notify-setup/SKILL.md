---
name: claude-notify-setup
description: Set up Claude Code notifications (announces/toasts when Claude needs input or finishes a turn) via a local VS Code extension with two channels - Alexa (Voice Monkey) and native Windows toast - both presence-aware and deduped. Use when the user wants to reproduce this notification system on a new machine, new VS Code profile, or wants to understand/rebuild it from scratch.
---

# Alexa Notify Setup

Reproduces a working Claude Code notification system: a small VS Code extension runs
a localhost HTTP server; Claude Code hooks (`Notification`, `Stop`, `PreToolUse`,
`UserPromptSubmit`) call it; the extension decides whether to actually notify
(presence-aware via idle-time + window-focus checks, deduped across overlapping
waits, cancellable via a grace period if the user responds quickly) and, if so,
dispatches to every enabled channel:

- **Alexa** (Voice Monkey API) - speaks through an Echo device.
- **Windows toast** - a native Action Center notification, no external account or
  service, clickable to bring VS Code to the foreground.

Both channels are independently toggleable in the extension's own panel. A third
channel (Microsoft Teams, via a Power Automate webhook) was explored and works when
tested directly, but is **not yet wired into the hooks below** - see
`MANUAL.md` in this skill's directory for its full setup and the complete
problem-statement/troubleshooting history across all three channels.

This skill's `assets/` directory contains the complete, working extension source
(already built and verified). Copy it, don't re-derive it from scratch.

## 1. Prerequisites

Confirm before starting:
- Windows with PowerShell, VS Code with the `code` CLI on PATH, Node.js + npm.
- **If the user wants the Alexa channel**: an Amazon Echo device, and a Voice Monkey
  account (https://voicemonkey.io) with an **Announcement**-type monkey created (not
  a Trigger-type - a Trigger-type monkey only replays a fixed Alexa Routine phrase
  and ignores dynamic `speech=` text; the whole point here is dynamic messages, so it
  must be Announcement-type).
- **If the user wants Windows toast only**: nothing beyond the Windows/VS Code basics
  above - no account, no device, no external service. Skip straight to step 3 and
  leave the Alexa fields at their defaults; the user can enable Alexa later from the
  panel once they have a Voice Monkey token.

Ask the user which channel(s) they want before proceeding. If Alexa is wanted, ask for:
1. Their Voice Monkey API token.
2. The Announcement monkey's device/slug name (shown in the Voice Monkey dashboard).

If they don't have a Voice Monkey account/monkey yet, tell them to set one up at
voicemonkey.io first (link their Amazon account, create an Announcement monkey),
then come back with the token and device name. Don't guess these values.

**Security**: once given the token, don't echo it back in full in chat or commit it
anywhere. It only ever goes into the token file in step 2.

## 2. Store the token (Alexa channel only)

Write the token to `~/.claude/voicemonkey-token.txt` (plain text, just the token,
nothing else). This keeps the secret out of `settings.json` and out of the
extension's source - the extension reads this file path at runtime. Skip this step
entirely if the user only wants the Windows toast channel.

## 3. Build and install the extension

Pick a project folder for the extension (e.g. `<workspace>/claude-alexa-notify`).
Copy every file under this skill's `assets/` directory into it, preserving structure
(`package.json`, `tsconfig.json`, `.vscodeignore`, `src/extension.ts`, `media/icon.png`).

**Fast path**: if `claude-alexa-notify-0.1.0.vsix` ships in this skill's directory,
install it directly and skip the build:
```
code --install-extension <this skill's directory>/claude-alexa-notify-0.1.0.vsix --force
```
Use the build below only if the `.vsix` is missing (for example, a mail filter
removed it) or if you need to change the source first.

Then, from that folder:
```
npm install
npx tsc -p ./
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension claude-alexa-notify-0.1.0.vsix --force
```
`vsce package` will warn about a missing LICENSE/repository field - harmless, ignore it.

**Defaults after install**: Windows toast is on. Alexa is off, with no device set.
A user who wants Alexa turns it on in the panel and enters their own device name.

**Tell the user to run "Developer: Reload Window"** (Command Palette) afterward. A
newly installed extension does not activate until the window reloads - you cannot
trigger this yourself.

If you later edit `src/extension.ts`, repeat the `tsc` + `vsce package` +
`code --install-extension --force` + reload cycle. Keep `.vscodeignore` listing any
throwaway files (icon drafts, test HTML pages) you create alongside the source so
they don't get bundled into the `.vsix`.

## 4. Wire up the Claude Code hooks

Read `~/.claude/settings.json` first and merge - never overwrite existing hooks or
other settings. Add all four of these hook events, each pointing at
`http://127.0.0.1:<port>` where `<port>` matches the extension's configured port
(default `8765` - see step 5):

| Event | Matcher | Posts to | Body |
|---|---|---|---|
| `Notification` | (none) | `/notification` | `{"message": <the notification message from stdin>}` |
| `Stop` | (none) | `/stop` | `{}` |
| `PreToolUse` | `""` (all tools) | `/resolved` | `{}` |
| `UserPromptSubmit` | (none) | `/resolved` | `{}` |

Use this exact command shape for `Notification` (it needs to read the message from
stdin JSON):
```powershell
$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; $msg = $j.message; $body = (@{ message = $msg } | ConvertTo-Json -Compress); try { Invoke-RestMethod -Uri "http://127.0.0.1:8765/notification" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 5 | Out-Null } catch {}
```
`Stop`, `PreToolUse`, and `UserPromptSubmit` are the same shape but simpler (no stdin
needed, just POST `"{}"` to `/stop` or `/resolved`):
```powershell
try { Invoke-RestMethod -Uri "http://127.0.0.1:8765/resolved" -Method Post -ContentType "application/json" -Body "{}" -TimeoutSec 3 | Out-Null } catch {}
```

All four hook entries should use `"type": "command"`, `"shell": "powershell"`,
`"async": true`, and a short `"timeout"` (5-10s) - async + short timeout means a
slow or blocked network call (corporate proxy, VPN, etc.) never stalls Claude Code
itself.

After editing, validate the JSON parses and all four events are present:
```powershell
$cfg = Get-Content "$env:USERPROFILE\.claude\settings.json" -Raw | ConvertFrom-Json
$cfg.hooks.PSObject.Properties.Name
```

## 5. Verify the Windows toast AUMID (do this before relying on the toast channel)

The extension's `showWindowsToast` calls
`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.VisualStudioCode")`.
That string is a hardcoded **AUMID** (Application User Model ID) - the identity Windows
uses to know which app a toast belongs to, and whether it's even allowed to show one.
`Microsoft.VisualStudioCode` is correct for a standard stable VS Code install, but is
**not guaranteed** on every machine (VS Code Insiders uses a different one; some
managed/enterprise images register apps under non-default AUMIDs or not at all).

Before trusting this channel on a new machine, verify it:
```powershell
Get-StartApps | Where-Object { $_.Name -match "Code|Visual Studio" } | Format-Table -AutoSize
```
Use whatever `AppID` comes back for the actual installed VS Code variant. If it differs
from `Microsoft.VisualStudioCode`, update the string in `src/extension.ts`
(`showWindowsToast`) before building. If nothing relevant shows up at all, toast
notifications likely won't work on that machine without further registration work -
tell the user and let them decide whether to pursue it or skip the toast channel.

Do **not** rely on `CreateToastNotifier()` with no argument - on managed/enterprise
Windows images this throws `Element not found. (Exception from HRESULT: 0x80070490)`
even though it works on an unmanaged personal machine. Always pass an explicit AUMID.

## 6. Configure and verify

1. Reload VS Code (if not already done in step 3).
2. Open the activity bar icon this extension adds -> the "Settings" panel.
3. Fill in / confirm whichever channels the user wants:
   - **Alexa**: Voice Monkey device name, token file path (defaults to the path
     from step 2).
   - **Windows toast**: no configuration needed beyond the AUMID check in step 5.
   - Shared: idle threshold, grace period, port.
4. Click "Send test announcement" and confirm you see/hear it (Echo speaks and/or a
   Windows toast appears, depending on which channels are enabled). If nothing
   happens, check the "Claude Alexa Notify" Output channel for errors (bad token
   path, Voice Monkey request failure, PowerShell/toast failure, etc).
5. To test the toast's click-to-focus behavior specifically: click the toast itself
   (not just observe it) and confirm VS Code comes to the foreground. This only
   works correctly once the extension (with its registered URI handler - see
   step 7) is actually running; a toast fired by a one-off raw PowerShell script
   outside the extension will not focus anything when clicked, since no handler is
   registered for `vscode://local.claude-alexa-notify/focus` in that case.
6. Pipe-test each real hook command directly before trusting live Claude Code
   events - e.g.:
   ```
   echo '{"message":"test"}' | powershell -Command "<the Notification hook command>"
   ```
7. Tell the user all settings live in this extension's own panel, not in VS Code's
   Settings UI (search for "alexaNotify" there should return nothing - that's
   intentional, everything is in one place by design).

## 7. Click-to-focus (Windows toast only)

The toast is built with `activationType="protocol"` and
`launch="vscode://local.claude-alexa-notify/focus"` set on its root XML element.
Clicking a protocol-activated toast makes Windows invoke that URI, which launches/
focuses the owning app as a side effect of the OS-level protocol dispatch - no
explicit "bring to front" API call is needed or available to extensions.

For VS Code to accept the URI instead of saying "no app registered to open this
link", the extension registers a handler in `activate()`:
```ts
vscode.window.registerUriHandler({
    handleUri(uri) { /* no-op is fine - just being invoked already focuses VS Code */ }
});
```
The authority part of the URI (`local.claude-alexa-notify`) must match the
extension's `publisher.name` from `package.json` exactly, or VS Code won't route it
anywhere and may show an error instead of focusing.

## 8. Known gotchas (learned building this the first time)

- **Corporate proxy latency**: behind a corporate proxy, the first call to Voice
  Monkey can take 10-20 seconds before succeeding. This is normal, not a failure -
  don't conclude it's broken just because it's slow.
- **Voice Monkey `/announce` needs `speech=`, not `text=`** - the v3 API renamed
  the field during a v2->v3 migration. If a request returns `{"success":true}` but
  nothing is spoken, or Alexa says "no announcement specified", the wrong param
  name is almost certainly the cause.
- **Announcement-type vs Trigger-type monkeys are not interchangeable.** A
  Trigger-type monkey's `/announce` call can return success while actually doing
  nothing (or replaying a fixed phrase) - dynamic text requires an Announcement-type
  monkey specifically.
- **A freshly installed/updated extension needs "Developer: Reload Window"** every
  single time - it silently does nothing until then. You cannot trigger this
  reload yourself; always ask the user and wait for confirmation before assuming
  new code is live.
- **`http.Server.close()` is asynchronous.** Don't start a new
  `http.createServer().listen()` on the same port before the old server's close
  callback has actually fired, or it can intermittently fail with `EADDRINUSE` and
  silently leave nothing listening.
- **Idle-check failure mode matters.** If the PowerShell idle-time check ever
  fails to run, treat it as "away" (a large number), never as "just active" (0) -
  the latter can permanently and silently suppress every future announcement if
  PowerShell ever stops working on that machine.
- **`vscode.workspace.getConfiguration` vs `context.globalState`**: if the user
  wants every setting to live in one custom panel only (not scattered across VS
  Code's Settings UI too), use `context.globalState` for storage, not
  `contributes.configuration` in `package.json` - the latter always surfaces in
  VS Code's native Settings UI with no supported way to hide it.
- **VS Code activity-bar icons are masked to the theme's color** (gray/white),
  so a colorful custom icon loses its colors there - only the shape survives.
  A PNG works as the `icon` field (not just SVG), which is useful if you want to
  use a real reference image directly instead of hand-drawing a vector shape.
- **`CreateToastNotifier()` with no AUMID argument fails on managed/enterprise
  Windows machines** (`Element not found`, HRESULT `0x80070490`), even though it
  works fine on an unmanaged personal machine. Always pass an explicit, verified
  AUMID (see step 5) - never ship the no-arg form.
- **A webview message handler with no try/catch can leave the UI stuck forever.**
  If a handler for a 'test'-style request throws before it posts a reply back, the
  webview shows "Sending..." (or equivalent) with no error and no way to recover
  short of reloading. Wrap the whole `onDidReceiveMessage` body in try/catch and
  always send *some* reply in the catch block, even just a failure result.
  Equally important: the error must be *logged* (to the Output channel) in that
  catch block, not just swallowed - otherwise you trade a stuck UI for a silent
  failure, which is just as hard to debug.
- **Full reference**: `MANUAL.md` in this skill's directory has the complete
  problem-statement, every solution path tried (including the Microsoft Teams
  channel, which works but isn't wired into the hooks here), and a fault-isolation
  table of every error message hit during development with its cause and fix.
