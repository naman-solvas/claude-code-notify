# Claude Code Notification System - Reference Manual

This manual describes the Claude Code notification system. It gives the problem
statement, each solution the team tried, and a fault-isolation table. Use this
manual to understand a past decision, to fix a fault, or to add a new channel.

This manual uses controlled language. Each sentence states one fact. Each term
has one meaning. The Glossary at the end of this manual lists all terms.

---

## 1. Scope

This manual covers the Claude Code notification system. The system tells the
user when Claude Code needs input, or when Claude Code finishes a turn. The
system sends this notice through one or more channels. A channel is a method
to tell the user. This manual describes three channels:

- Channel A: Alexa, through the Voice Monkey service.
- Channel B: Microsoft Teams, through a Power Automate flow.
- Channel C: Windows toast, through the Windows notification platform.

This manual also describes the VS Code extension that controls all channels.
The name of the extension is **Claude Alexa Notify**. The extension ID is
`local.claude-alexa-notify`.

---

## 2. Problem Statement

Claude Code can stop and wait for the user. Claude Code can also finish a turn
without more input. In both cases, the user may not look at the screen. The
user may be in another room, at another desk, or away from the computer.

The user needs a notice outside the IDE window. The notice must reach the user
in different conditions:

1. The user works from home, near an Amazon Echo device.
2. The user works from an office desk, with no Echo device, but with access to
   Microsoft Teams.
3. The user sits at the computer, but looks at a different window.

A single channel cannot cover all three conditions. The system must support
more than one channel. The system must let the user turn each channel on or
off. The system must not send a notice when the user is already at the
computer and looking at it. The system must not send a notice twice for one
event.

---

## 3. System Overview

### 3.1 Components

| Component | Role |
|---|---|
| Claude Code hooks | Fire on four events: `Notification`, `Stop`, `PreToolUse`, `UserPromptSubmit`. Each hook runs a short PowerShell command. |
| The extension | A VS Code extension. The extension runs a local HTTP server. The extension holds all channel logic. |
| A channel | One method to notify the user: Alexa, Teams, or Windows toast. |

### 3.2 Data Flow

1. Claude Code fires a hook.
2. The hook command sends an HTTP POST request to the extension's local
   server, at `http://127.0.0.1:<port>`. The default port is `8765`.
3. The extension reads the request. The extension decides if the user is
   present. The extension decides if the event is a duplicate.
4. If the extension decides to notify, the extension calls the `notify`
   function.
5. The `notify` function sends the message to each enabled channel.

### 3.3 Why the Logic Lives in the Extension, Not the Hooks

The hook commands are short. Each hook command only forwards the event to the
extension. All decision logic — presence checks, duplicate checks, the grace
period, and each channel's own method — lives in the extension's code. This
design has one reason: the hook commands run once per event, with no shared
state between runs. The extension process stays alive between events. Only a
long-lived process can hold state, like a counter or a timer.

### 3.4 Presence Check

The extension can check if the user is present. The extension uses two
signals:

- **Window-focus check**: Is the VS Code window the active window?
- **Idle-time check**: Has the user pressed a key or moved the mouse in the
  last N seconds? The default value of N is 60.

The user can turn each signal on or off. The presence check combines every
*enabled* signal with logical AND. If the user turns off both signals, the
presence check always returns "not present". This behavior is correct: with no
signal on, only the master per-channel switch controls the notice.

**Rule**: If a signal fails to read (for example, the idle-time check cannot
run), the signal must report "not present" (the user is away), never
"present". A fail-to-present state would block every future notice without
a visible error. See Fault Isolation entry F-6.

### 3.5 Duplicate Prevention and the Grace Period

The system must not speak or show a notice twice for one event. The system
must also not speak after the user already responds. The extension solves
both problems with two features.

**Feature 1: Grace period.** When a `Notification` event arrives, the
extension does not notify right away. The extension waits a short time first,
by default 3000 ms (3 seconds). The extension calls this the "grace period".
During the grace period, a `PreToolUse` or `UserPromptSubmit` event can
cancel the pending notice. This design exists because Claude Code may finish
waiting for the user before the notice channel completes its own round trip
(for example, a corporate proxy can add many seconds of delay to a Voice
Monkey request). Without a grace period, the channel may still fire the
notice after the user already responds.

**Feature 2: Wait counter.** The extension holds a counter named
`pendingWaitCount`. Each `Notification` event adds 1 to the counter. Each
`PreToolUse` or `UserPromptSubmit` event removes 1 from the counter, to a
floor of 0. The extension only starts a new grace period if no grace period
is already running. The extension only cancels the queued notice when the
counter reaches 0. This design handles the case of two or more pending waits
at the same time: the first resolved wait must not cancel the still-pending
second wait.

**Feature 3: One reminder, not many.** If the grace period ends and the user
is still not present, the extension sends the notice. The extension then
starts a 120-second timer. If the counter is still above 0 when this timer
ends, the extension sends one more notice: "Claude Code is still waiting for
you." After this second notice, the extension stops tracking the event, even
if the user never responds. The system sends at most two notices per event:
the first notice and one reminder.

---

## 4. Channel A: Alexa (Voice Monkey)

### 4.1 Description

This channel makes an Amazon Echo device speak the message out loud. The
channel uses the Voice Monkey web service. Voice Monkey bridges a web request
to an Alexa announcement.

### 4.2 Prerequisites

- An Amazon Echo device, linked to the user's Amazon account.
- A Voice Monkey account, at `voicemonkey.io`.
- One Voice Monkey "monkey" of type **Announcement**. A monkey of type
  **Trigger** does not work for this channel; see Fault Isolation entry F-1.

### 4.3 Setup Procedure

1. Create a Voice Monkey account. Link the account to the user's Amazon
   account.
2. In the Voice Monkey dashboard, create a monkey. Set the monkey's type to
   **Announcement**.
3. Copy the monkey's API token. Copy the monkey's device name.
4. Save the token to a local file: `~/.claude/voicemonkey-token.txt`. Write
   only the token to this file.
5. In the extension's panel, enter the device name. Confirm the token file
   path.
6. Click "Send test announcement". Confirm the Echo device speaks the test
   message.

### 4.4 API Reference

- Endpoint: `https://api-v3.voicemonkey.io/announce`
- Method: `GET`
- Required parameters: `token`, `device`, `speech`
- The parameter for the spoken text is `speech`, not `text`. The `text`
  parameter name was valid in Voice Monkey's v2 API. The v3 API renamed this
  parameter. See Fault Isolation entry F-2.

### 4.5 Known Limitations

- A corporate network proxy can add 10 to 20 seconds
  of delay to the first request. This delay is normal. This delay is not a
  fault.
- The channel sends the token in the request URL. Treat the token as a
  secret. Do not commit the token to source control. Do not print the full
  token in chat.

---

## 5. Channel B: Microsoft Teams

### 5.1 Description

This channel posts the message into a Microsoft Teams chat. The channel uses
a Power Automate flow. The flow exposes a webhook URL. A POST request to this
URL starts the flow. The flow posts the message as a card.

**Status**: This channel works. A manual test confirmed end-to-end delivery.
This channel is **not yet connected** to the Claude Code hooks. To connect
this channel, add a hook command that posts to the flow's webhook URL, in the
same pattern as the Alexa channel's hook command.

### 5.2 Prerequisites

- A Microsoft Teams account, in an organization that allows Power Automate
  flows with an HTTP trigger. Some organizations block this trigger type
  through a data-loss-prevention (DLP) policy.
- The "Workflows" app, inside Microsoft Teams. This app replaced the older
  "Incoming Webhook" connector. Microsoft retired the older connector.

### 5.3 Setup Procedure

1. In Microsoft Teams, open the "Workflows" app.
2. Open the "Templates" tab. Find the template named **"Send webhook alerts
   to a chat"**. Do not use the template named "Send webhook alerts to a
   channel"; that template posts to a shared channel, visible to a whole
   team. See Fault Isolation entry F-3 for the reason to avoid it.
3. Create the flow from this template.
4. Open the flow. Copy the webhook URL, from the "Copy webhook link" control.
5. Treat the webhook URL as a secret. The URL contains a `sig` query
   parameter. This parameter is a bearer credential. A party with this URL
   can trigger the flow.
6. Open the flow in the Power Automate editor (the "Edit" control).
7. Find the action named **"Post card in a chat or channel"**.
8. Set the "Post as" field to **"Flow bot"**.
9. Set the "Post in" field to **"Chat with Flow bot"**. Do not set this field
   to "Group chat" with a target of `48:notes`. This target is the user's
   personal "Notes" self-chat. This target is not a valid chat thread for
   this action. See Fault Isolation entry F-4.
10. Set the "Recipient" field to the user's own account.
11. Set the "Adaptive Card" field to the JSON text in section 5.5.
12. If the flow has a condition step named "Attachments is null", delete this
    condition step. Keep only one, unconditional "Post card in a chat or
    channel" action, directly after the flow's variable-initialization steps.
    See Fault Isolation entry F-5 for the reason to delete this condition.
13. Save the flow.
14. Send a test POST request to the webhook URL. Confirm the message appears
    in the "Chat with Flow bot" conversation.

### 5.4 Webhook Payload

Send a POST request, with header `Content-Type: application/json`, and this
body:
```json
{"@type": "MessageCard", "@context": "http://schema.org/extensions", "text": "<message>"}
```
This is the "MessageCard" format. The flow also accepts an "Adaptive Card"
format, with an `attachments` array, but the MessageCard format is simpler
and is the format used in all working tests for this channel.

### 5.5 Adaptive Card Field Value

Enter this exact text into the "Adaptive Card" field of the "Post card in a
chat or channel" action:
```
{"type":"AdaptiveCard","$schema":"http://adaptivecards.io/schemas/adaptive-card.json","version":"1.4","body":[{"type":"TextBlock","text":"@{variables('Body')?['text']}","wrap":true}]}
```
The text `@{variables('Body')?['text']}` is a Power Automate expression. This
expression reads the `text` property from the flow's `Body` variable. The
`Body` variable holds the whole incoming request body, as an object, not as a
string. Do not wrap this expression in a `json(...)` function; the `json`
function expects a string input, and the `Body` variable is already an
object. See Fault Isolation entry F-7.

Type the expression text directly into the field. The Power Automate
designer accepts the `@{...}` syntax as plain text. The designer then renders
the expression as a chip, in the same way a value chosen from the dynamic-
content picker renders.

### 5.6 Display Name Limitation

The message in Teams shows a sender name of "Workflows", not "Claude Code".
This name is the fixed identity of the Power Automate connector. Every flow
in the organization that posts "as Flow bot" shares this one identity. No
per-flow setting changes this name.

To show a name other than "Workflows", two options exist:

- **Option 1 (low effort)**: Post to a **private Teams channel**, named
  "Claude Code", with only the user as a member. A channel has its own name,
  separate from the sender's name. The sender name still shows "Workflows".
- **Option 2 (high effort)**: Build a true Teams bot application. A true bot
  needs an Azure Bot Service registration, a Teams app manifest, and a
  hosted backend that implements the Bot Framework protocol. A true bot can
  show its own custom name and icon, in the same way the GitHub or Azure
  DevOps Teams apps do. This option needs far more setup work than this
  system's other two channels.

Neither option is in place as of this manual's writing. The channel works
with the default "Workflows" sender name.

---

## 6. Channel C: Windows Toast Notification

### 6.1 Description

This channel shows a native Windows notification, in the Windows Action
Center. This channel needs no external account and no external network call.
This channel works even when the VS Code window is not the active window, or
is minimized.

### 6.2 Prerequisites

- Windows 10 or Windows 11.
- PowerShell 5.1, with access to the Windows Runtime (WinRT) notification
  classes.
- A registered Application User Model ID (AUMID). See section 6.3.

### 6.3 The AUMID Requirement

A Windows toast notification needs an AUMID. The AUMID tells Windows which
application owns the notification. Without a valid AUMID, the call to create
a toast notifier fails.

The call `CreateToastNotifier()`, with no argument, fails on a managed or
enterprise Windows machine, with this error:
```
Element not found. (Exception from HRESULT: 0x80070490)
```
This call can succeed on an unmanaged personal machine. Do not rely on this
call with no argument. See Fault Isolation entry F-8.

**Procedure to find a valid AUMID**:
1. Run this PowerShell command:
   ```powershell
   Get-StartApps | Where-Object { $_.Name -match "Code|Visual Studio" } | Format-Table -AutoSize
   ```
2. Read the `AppID` column, for the row that matches the installed VS Code
   variant.
3. Use this `AppID` value as the argument to `CreateToastNotifier`.

On the machine used to build this system, the correct AUMID was
`Microsoft.VisualStudioCode`. This value is specific to a standard, stable
VS Code install. A VS Code Insiders install, or a non-standard install, may
use a different AUMID. Confirm the AUMID on each new machine; do not assume
the same value applies everywhere.

### 6.4 Toast Content Procedure

The extension builds the toast with this PowerShell logic:

1. Load three WinRT types: `ToastNotificationManager`, `ToastNotification`,
   and `XmlDocument`.
2. Get a template of type `ToastText02`. This template has two text fields:
   a title field, and a body field.
3. Set the title field to the string `"Claude Code"`.
4. Set the body field to the message text.
5. Create the toast notification object, from the filled template.
6. Call `CreateToastNotifier`, with the AUMID argument. Call `Show`, with the
   toast notification object.

### 6.5 Click-to-Focus Procedure

A toast notification, by default, does nothing when the user clicks it. This
system adds a click action: a click brings the VS Code window to the front.

This action needs two parts, in the extension:

**Part 1: Toast attributes.** Before creation, set two attributes on the
toast template's root XML element:
```powershell
$toastRoot = $template.DocumentElement
$toastRoot.SetAttribute("activationType", "protocol")
$toastRoot.SetAttribute("launch", "vscode://local.claude-alexa-notify/focus")
```
The `launch` value is a URI. The URI scheme is `vscode`. The URI authority is
the extension's ID, in the form `<publisher>.<name>`, read from the
extension's `package.json` file.

**Part 2: A registered URI handler.** In the extension's `activate` function,
register a handler for this URI scheme:
```ts
vscode.window.registerUriHandler({
    handleUri(uri) { /* this function can do nothing; the registration alone is enough */ }
});
```
This registration serves one purpose: it tells VS Code that this extension
accepts a `vscode://local.claude-alexa-notify/...` URI. Without this
registration, VS Code may show an error instead of a silent focus action,
when Windows invokes the URI.

**Why no direct "focus the window" call exists**: A VS Code extension has no
API to force its own window to the foreground, at will. The focus action
here is a side effect of the operating system's normal protocol-activation
behavior: when an app registers to handle a URI, and the OS invokes that URI,
the OS brings the target app forward as part of the invocation. The
extension code does not need to request focus; the OS grants it.

---

## 7. Fault Isolation

Use this table to find the cause of an observed symptom, and the corrective
action.

| ID | Symptom | Cause | Corrective Action |
|---|---|---|---|
| F-1 | Voice Monkey API call returns success, but Alexa speaks a fixed, unrelated phrase, or says nothing. | The monkey is of type "Trigger", not "Announcement". A Trigger-type monkey fires a fixed Alexa Routine; it ignores the `speech` parameter. | Create a new monkey, of type "Announcement", in the Voice Monkey dashboard. |
| F-2 | Alexa says "No announcement specified." | The request used the parameter name `text`. The Voice Monkey v3 API renamed this parameter to `speech`. | Use the parameter name `speech`, not `text`, in the request URL. |
| F-3 | A Teams notice is visible to the whole team, not only to the one user. | The Power Automate flow used the template "Send webhook alerts to a channel", which posts to a shared channel. | Rebuild the flow from the template "Send webhook alerts to a chat". Set "Post in" to "Chat with Flow bot". |
| F-4 | The Teams flow run fails, with error text that includes `Call made for a thread which is not a ChatThread`. | The "Post in" field targets `48:notes`, the user's personal Notes self-chat. This target is not a valid chat thread. | Change "Post in" to "Chat with Flow bot". Set "Recipient" to the user's own account. |
| F-5 | The Teams flow run fails, with error text that includes `the result of the evaluation of 'foreach' expression ... is of type 'Null'`, in an action named `For_each_1`. | A condition step ("Attachments is null") routed the run into a branch that expects an `attachments` array. The incoming request had no `attachments` field. | Delete the condition step. Keep one, unconditional "Post card in a chat or channel" action. |
| F-6 | A Windows toast notice, or an Alexa notice, stops firing, with no visible error, after working before. | The idle-time check's PowerShell call failed. The code path that handles this failure returned a value that reads as "user is present" (a low idle time, such as 0). | Change the failure path to return a large idle-time value (for example, infinity), so a failed check reads as "user is away", not "user is present". |
| F-7 | A Teams flow run fails, with error text that includes `The template language function 'json' expects its parameter to be a string or an XML. The provided value is of type 'Object'`. | The flow's `Body` variable already holds a parsed object. The expression wrapped this object in a `json(...)` call, which expects a string input. | Remove the `json(...)` wrapper. Use `variables('Body')?['text']` directly. |
| F-8 | A PowerShell call to `CreateToastNotifier()`, with no argument, fails, with error text that includes `Element not found` and HRESULT `0x80070490`. | The machine has no AUMID registered for a no-argument call. This condition is common on a managed or enterprise Windows image. | Find a valid, already-registered AUMID with `Get-StartApps`. Pass this AUMID as an explicit argument to `CreateToastNotifier`. |
| F-9 | A webview panel's "Send test announcement" control shows "Sending...", with no change, for an indefinite time. | The message handler, in the extension's code, threw an error before it sent a reply message back to the webview. No try/catch block existed around the handler. | Wrap the whole message-handler function body in a try/catch block. In the catch block, log the error, and send a failure reply back to the webview. |
| F-10 | A local HTTP connection to the extension's server (for example, `http://127.0.0.1:8765`) fails, with a "connection refused" result. | The extension's `activate` function did not run, or ran but failed before it started the local server. A common cause: the VS Code window was not reloaded after a new build of the extension. | Confirm the user ran "Developer: Reload Window" after the install step. Check the "Claude Alexa Notify" Output channel for an activation error. Re-test the port after confirming the reload. |
| F-11 | A rapid change to the "Local port" field, in the extension's panel, leaves the server not listening, on any port. | `http.Server.close()` is an asynchronous call. A new `listen()` call, on a new port, can start before the old server fully releases its port, in rare timing conditions. | Call `close()` with a callback function. Start the new server only inside that callback function, not immediately after the `close()` call. |

---

## 8. Glossary

| Term | Meaning |
|---|---|
| Channel | One method the system uses to notify the user: Alexa, Teams, or Windows toast. |
| The extension | The VS Code extension named Claude Alexa Notify, ID `local.claude-alexa-notify`. |
| A hook | A Claude Code configuration entry that runs a command on a named event (`Notification`, `Stop`, `PreToolUse`, `UserPromptSubmit`). |
| Presence | A computed state: whether the user is currently at the computer and looking at VS Code. |
| Grace period | A short wait, before the extension sends a first notice, during which a resolved event can cancel the notice. |
| Wait counter | A number, held by the extension, that counts how many `Notification` events are still unresolved. |
| Monkey | A Voice Monkey account object. A monkey has a type: Announcement or Trigger. |
| Flow | A Microsoft Power Automate workflow. In this system, one flow receives a webhook request and posts a Teams message. |
| AUMID | Application User Model ID. A string Windows uses to identify the application that owns a toast notification. |
| Toast | A Windows notification shown in the Action Center. |
| URI handler | A registered function, inside a VS Code extension, that receives a `vscode://` link when the operating system invokes it. |
