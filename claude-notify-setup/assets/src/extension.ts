import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let server: http.Server | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let state: vscode.Memento;

// Dedup + reminder state for the Notification event. A counter rather than a
// boolean: if two independent Notification events arrive close together
// (e.g. two parallel tool-permission requests), resolving the first must not
// wipe out tracking for the second.
let pendingWaitCount = 0;
let timerActive = false;
let reminderTimer: NodeJS.Timeout | undefined;
// Cancellation-token style grace timer: holds the announcement until this
// fires, so a quick approval (PreToolUse/UserPromptSubmit) can cancel it
// before Alexa ever gets the request.
let pendingNotificationTimer: NodeJS.Timeout | undefined;

const REMINDER_DELAY_MS = 120_000;

// Alexa is off by default: it needs a personal Echo + Voice Monkey account.
// The Windows toast needs nothing, so it is on by default.
const DEFAULTS = {
    enabled: false,
    windowsToastEnabled: true,
    useIdleCheck: true,
    useFocusCheck: true,
    idleThresholdSeconds: 60,
    tokenFile: '~/.claude/voicemonkey-token.txt',
    device: '',
    port: 8765,
    graceMs: 3000
};

function log(msg: string) {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function expandHome(p: string): string {
    if (p.startsWith('~')) {
        return path.join(os.homedir(), p.slice(1));
    }
    return p;
}

// All settings now live in the extension's own private storage (globalState),
// not vscode.workspace configuration - so everything is configured through
// this extension's own panel only, and never leaks into VS Code's Settings UI.
function getConfig() {
    return {
        enabled: state.get<boolean>('enabled', DEFAULTS.enabled),
        windowsToastEnabled: state.get<boolean>('windowsToastEnabled', DEFAULTS.windowsToastEnabled),
        useIdleCheck: state.get<boolean>('useIdleCheck', DEFAULTS.useIdleCheck),
        useFocusCheck: state.get<boolean>('useFocusCheck', DEFAULTS.useFocusCheck),
        idleThresholdSeconds: state.get<number>('idleThresholdSeconds', DEFAULTS.idleThresholdSeconds),
        tokenFile: expandHome(state.get<string>('tokenFile', DEFAULTS.tokenFile)),
        device: state.get<string>('device', DEFAULTS.device),
        port: state.get<number>('port', DEFAULTS.port),
        graceMs: state.get<number>('graceMs', DEFAULTS.graceMs)
    };
}

async function setConfigValue(key: string, value: unknown) {
    await state.update(key, value);
    updateStatusBar();
    viewProvider?.refresh();
    if (key === 'port') {
        startServer(getConfig().port);
    }
}

// System idle time via a quick PowerShell call to GetLastInputInfo.
// (No pure-Node API exists for this; this is the one place we still shell out.)
// Async and non-blocking - execFileSync would freeze the whole extension host
// (shared with every other extension) for up to its timeout on every call.
function getIdleSeconds(): Promise<number> {
    return new Promise((resolve) => {
        const { execFile } = require('child_process');
        const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IdleCheck {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@
$lii = New-Object IdleCheck+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
[void][IdleCheck]::GetLastInputInfo([ref]$lii)
Write-Output ([Environment]::TickCount - $lii.dwTime)
`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 }, (err: any, stdout: string) => {
            if (err) {
                log(`getIdleSeconds failed: ${err}`);
                // Fail safe: treat as "away" (large idle value) so a PowerShell
                // failure can never permanently suppress announcements - the
                // opposite of returning 0, which would mean "always present".
                resolve(Number.POSITIVE_INFINITY);
                return;
            }
            resolve(parseInt(stdout.trim(), 10) / 1000);
        });
    });
}

// Presence = AND of every *enabled* check. If neither check is enabled, presence is false
// (i.e. never suppress based on presence - only the master "enabled" switch gates announcements).
async function isUserPresent(): Promise<boolean> {
    const cfg = getConfig();
    const checks: boolean[] = [];

    if (cfg.useFocusCheck) {
        checks.push(vscode.window.state.focused);
    }
    if (cfg.useIdleCheck) {
        checks.push((await getIdleSeconds()) < cfg.idleThresholdSeconds);
    }

    if (checks.length === 0) {
        return false;
    }
    return checks.every(c => c);
}

function announce(message: string) {
    const cfg = getConfig();
    if (!cfg.device) {
        log('Alexa skipped: no Voice Monkey device set in the panel');
        return;
    }
    let token: string;
    try {
        token = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    } catch (e) {
        log(`Could not read token file ${cfg.tokenFile}: ${e}`);
        return;
    }
    const speech = encodeURIComponent(message);
    const url = `https://api-v3.voicemonkey.io/announce?token=${token}&device=${encodeURIComponent(cfg.device)}&speech=${speech}`;
    log(`Announcing: "${message}"`);
    const req = https.get(url, { timeout: 20000 }, (res) => {
        res.on('data', () => {});
        res.on('end', () => log(`Voice Monkey responded: ${res.statusCode}`));
    });
    req.on('error', (e) => log(`Voice Monkey request failed: ${e}`));
    req.on('timeout', () => req.destroy());
}

// Single-quoted PowerShell string literal escaping (double up embedded quotes).
function psQuote(s: string): string {
    return "'" + String(s).replace(/'/g, "''") + "'";
}

// Native Windows toast (Action Center), visible even if VS Code isn't
// focused or is minimized - no external service, no account, no network call.
function showWindowsToast(title: string, message: string) {
    const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName("text")
$textNodes.Item(0).AppendChild($template.CreateTextNode(${psQuote(title)})) | Out-Null
$textNodes.Item(1).AppendChild($template.CreateTextNode(${psQuote(message)})) | Out-Null
$toastRoot = $template.DocumentElement
$toastRoot.SetAttribute("activationType", "protocol") | Out-Null
$toastRoot.SetAttribute("launch", "vscode://local.claude-alexa-notify/focus") | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.VisualStudioCode").Show($toast)
`;
    const { execFile } = require('child_process');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000 }, (err: any) => {
        if (err) { log(`Windows toast failed: ${err}`); }
    });
}

// Dispatches to every enabled channel - callers don't need to know which
// channels exist, just that "notify" should happen.
function notify(message: string) {
    const cfg = getConfig();
    if (cfg.enabled) {
        announce(message);
    }
    if (cfg.windowsToastEnabled) {
        showWindowsToast('Claude Code', message);
    }
}

async function handleNotification(message: string) {
    const cfg = getConfig();
    if (!cfg.enabled && !cfg.windowsToastEnabled) {
        log('Notification ignored: all channels disabled');
        return;
    }
    if (await isUserPresent()) {
        log('Notification ignored: user present');
        return;
    }

    // Count this as one more thing we're waiting on. Only start the
    // grace/announce/reminder cycle once (dedup), but every distinct wait
    // still has to be individually resolved before we stop tracking.
    pendingWaitCount += 1;
    log(`Notification received (pendingWaitCount=${pendingWaitCount})`);
    if (timerActive) {
        log('Dedup: a grace/reminder cycle is already running for this wait');
        return;
    }

    timerActive = true;
    log(`Holding for ${cfg.graceMs}ms grace period before announcing`);

    pendingNotificationTimer = setTimeout(async () => {
        pendingNotificationTimer = undefined;
        const stillAnyEnabled = getConfig().enabled || getConfig().windowsToastEnabled;
        if (pendingWaitCount <= 0 || !stillAnyEnabled || (await isUserPresent())) {
            log('Grace period elapsed but no longer applicable - not announcing');
            timerActive = false;
            pendingWaitCount = 0;
            return;
        }

        notify(message || 'Claude Code needs your input');

        reminderTimer = setTimeout(async () => {
            const cfgNow = getConfig();
            if (pendingWaitCount > 0 && (cfgNow.enabled || cfgNow.windowsToastEnabled) && !(await isUserPresent())) {
                notify('Claude Code is still waiting for you');
            }
            // One follow-up only (not infinite nagging) - stop tracking this
            // cycle either way once the reminder window has passed.
            timerActive = false;
            pendingWaitCount = 0;
            reminderTimer = undefined;
        }, REMINDER_DELAY_MS);
    }, cfg.graceMs);
}

// Fires on PreToolUse/UserPromptSubmit - the signal that whatever Claude was
// waiting on just got resolved. Decrements the wait counter; only cancels the
// held/queued announcement once every known wait has been resolved.
function handleResolved() {
    if (pendingWaitCount > 0) {
        pendingWaitCount -= 1;
    }
    log(`Resolved signal received (pendingWaitCount now ${pendingWaitCount})`);

    if (pendingWaitCount === 0) {
        if (pendingNotificationTimer) {
            clearTimeout(pendingNotificationTimer);
            pendingNotificationTimer = undefined;
            timerActive = false;
            log('All pending waits resolved before grace period elapsed - announcement cancelled');
        } else if (reminderTimer) {
            clearTimeout(reminderTimer);
            reminderTimer = undefined;
            timerActive = false;
            log('All pending waits resolved - cancelled queued reminder');
        }
    }
}

async function handleStop() {
    // Turn ended - any pending notification concern is moot now
    if (pendingNotificationTimer) {
        clearTimeout(pendingNotificationTimer);
        pendingNotificationTimer = undefined;
    }
    if (reminderTimer) {
        clearTimeout(reminderTimer);
        reminderTimer = undefined;
    }
    pendingWaitCount = 0;
    timerActive = false;

    const cfg = getConfig();
    if (!cfg.enabled && !cfg.windowsToastEnabled) {
        log('Stop ignored: all channels disabled');
        return;
    }
    if (await isUserPresent()) {
        log('Stop ignored: user present');
        return;
    }
    notify('Claude Code has finished and is idle');
}

function startServer(port: number) {
    const createAndListen = () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                let parsed: any = {};
                try { parsed = body ? JSON.parse(body) : {}; } catch { /* ignore */ }

                if (req.method === 'POST' && req.url === '/notification') {
                    handleNotification(parsed.message);
                } else if (req.method === 'POST' && req.url === '/stop') {
                    handleStop();
                } else if (req.method === 'POST' && req.url === '/resolved') {
                    handleResolved();
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            });
        });
        // Bind to localhost only - never exposed beyond this machine
        server.listen(port, '127.0.0.1', () => log(`Listening on 127.0.0.1:${port}`));
        server.on('error', (e) => log(`Server error: ${e}`));
    };

    if (server) {
        // close() is async - wait for it to actually release the port before
        // listening again, or a rapid port change can race into EADDRINUSE
        // and silently leave nothing listening.
        const old = server;
        server = undefined;
        old.close(() => createAndListen());
    } else {
        createAndListen();
    }
}

function updateStatusBar() {
    const cfg = getConfig();
    const anyChannelOn = cfg.enabled || cfg.windowsToastEnabled;
    statusBarItem.text = anyChannelOn ? '$(unmute) Alexa' : '$(mute) Alexa';
    statusBarItem.tooltip = anyChannelOn
        ? 'Claude Alexa Notify: announcements ON (click to mute Alexa)'
        : 'Claude Alexa Notify: announcements OFF (click to unmute Alexa)';
}

class AlexaNotifyViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'claudeAlexaNotify.panel';
    private view?: vscode.WebviewView;

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            try {
                if (msg.type === 'ready') {
                    this.refresh();
                } else if (msg.type === 'update') {
                    await setConfigValue(msg.key, msg.value);
                } else if (msg.type === 'test') {
                    const cfg = getConfig();
                    if (!cfg.enabled && !cfg.windowsToastEnabled) {
                        this.view?.webview.postMessage({ type: 'testResult', ok: false });
                        return;
                    }
                    notify('This is a test announcement from Claude Alexa Notify');
                    this.view?.webview.postMessage({ type: 'testResult', ok: true });
                }
            } catch (e) {
                // Whatever went wrong, the webview must not be left showing
                // "Sending..." forever with no feedback.
                log(`onDidReceiveMessage error handling '${msg?.type}': ${e}`);
                if (msg?.type === 'test') {
                    this.view?.webview.postMessage({ type: 'testResult', ok: false });
                }
            }
        });

        this.refresh();
    }

    refresh() {
        if (!this.view) { return; }
        const cfg = getConfig();
        this.view.webview.postMessage({ type: 'state', ...cfg });
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 16px 14px;
    margin: 0;
    font-size: 13px;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 4px 8px;
    border-radius: 999px;
    margin-bottom: 20px;
    font-weight: 500;
    font-size: 12px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.15));
  }
  .status.on { color: #3fb950; }
  .status.off { color: var(--vscode-descriptionForeground); }
  .status .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
    transition: opacity 0.15s;
  }
  .row.disabled { opacity: 0.4; pointer-events: none; }
  .row .text { flex: 1; min-width: 0; }
  .row .title { font-weight: 500; cursor: pointer; }
  .row .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  .switch { position: relative; width: 34px; height: 18px; flex: none; margin-top: 0; display: inline-block; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; cursor: pointer; inset: 0; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3)); border-radius: 999px; transition: 0.15s; }
  .slider::before { content: ""; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; border-radius: 50%; background: var(--vscode-foreground); transition: 0.15s; }
  input:checked + .slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  input:checked + .slider::before { transform: translateX(16px); background: var(--vscode-button-foreground); }

  .sectionHeader { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; font-weight: 600; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-foreground); }
  .field input[type=text], .field input[type=number] {
    width: 100%; padding: 5px 7px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
  }
  .field input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .field input[type=number] { -moz-appearance: textfield; }
  .field input[type=number]::-webkit-inner-spin-button,
  .field input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }

  button#testBtn { margin-top: 18px; width: 100%; padding: 8px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; }
  button#testBtn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button#testBtn:disabled { opacity: 0.4; cursor: not-allowed; }
  #testResult { margin-top: 8px; font-size: 11px; min-height: 14px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="status" id="statusBadge"><span class="dot"></span><span id="statusText">Loading...</span></div>

  <div class="row">
    <div class="text">
      <div class="title" data-for="enabled">Alexa announcements</div>
      <div class="hint">Voice Monkey audio announcement - turn off for office mode</div>
    </div>
    <label class="switch"><input type="checkbox" id="enabled"><span class="slider"></span></label>
  </div>

  <div class="row">
    <div class="text">
      <div class="title" data-for="windowsToastEnabled">Windows notification</div>
      <div class="hint">Native toast, visible even if VS Code isn't focused - no external service</div>
    </div>
    <label class="switch"><input type="checkbox" id="windowsToastEnabled"><span class="slider"></span></label>
  </div>

  <div class="row" id="idleRow">
    <div class="text">
      <div class="title" data-for="useIdleCheck">Use idle-time check</div>
      <div class="hint">Suppress if you've typed/clicked recently</div>
    </div>
    <label class="switch"><input type="checkbox" id="useIdleCheck"><span class="slider"></span></label>
  </div>

  <div class="row" id="focusRow">
    <div class="text">
      <div class="title" data-for="useFocusCheck">Use window-focus check</div>
      <div class="hint">Suppress if this VS Code window is focused</div>
    </div>
    <label class="switch"><input type="checkbox" id="useFocusCheck"><span class="slider"></span></label>
  </div>

  <div class="sectionHeader">Advanced</div>

  <div class="field">
    <label for="idleThresholdSeconds">Idle threshold (seconds)</label>
    <input type="number" id="idleThresholdSeconds" min="5" step="5">
  </div>
  <div class="field">
    <label for="graceMs">Grace period before announcing (ms)</label>
    <input type="number" id="graceMs" min="0" step="500">
  </div>
  <div class="field">
    <label for="device">Voice Monkey device</label>
    <input type="text" id="device" spellcheck="false">
  </div>
  <div class="field">
    <label for="tokenFile">Voice Monkey token file</label>
    <input type="text" id="tokenFile" spellcheck="false">
  </div>
  <div class="field">
    <label for="port">Local port</label>
    <input type="number" id="port" min="1024" max="65535">
  </div>

  <button id="testBtn">Send test announcement</button>
  <div id="testResult"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const toggleIds = ['enabled', 'windowsToastEnabled', 'useIdleCheck', 'useFocusCheck'];
    const textIds = ['idleThresholdSeconds', 'device', 'tokenFile', 'port', 'graceMs'];
    const numberIds = ['idleThresholdSeconds', 'port', 'graceMs'];

    for (const id of toggleIds) {
      document.getElementById(id).addEventListener('change', (e) => {
        vscode.postMessage({ type: 'update', key: id, value: e.target.checked });
      });
    }
    for (const id of textIds) {
      document.getElementById(id).addEventListener('change', (e) => {
        const value = numberIds.includes(id) ? Number(e.target.value) : e.target.value;
        vscode.postMessage({ type: 'update', key: id, value });
      });
    }
    document.querySelectorAll('.title').forEach((el) => {
      el.addEventListener('click', () => {
        const cb = document.getElementById(el.dataset.for);
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
    });
    document.getElementById('testBtn').addEventListener('click', () => {
      document.getElementById('testResult').textContent = 'Sending...';
      vscode.postMessage({ type: 'test' });
    });

    function applyState(st) {
      for (const id of toggleIds) {
        document.getElementById(id).checked = !!st[id];
      }
      for (const id of textIds) {
        document.getElementById(id).value = st[id];
      }
      const badge = document.getElementById('statusBadge');
      const text = document.getElementById('statusText');
      const testBtn = document.getElementById('testBtn');
      const anyChannelOn = st.enabled || st.windowsToastEnabled;
      badge.className = anyChannelOn ? 'status on' : 'status off';
      text.textContent = anyChannelOn ? 'Active' : 'Muted';
      document.getElementById('idleRow').classList.toggle('disabled', !anyChannelOn);
      document.getElementById('focusRow').classList.toggle('disabled', !anyChannelOn);
      testBtn.disabled = !anyChannelOn;
      testBtn.title = anyChannelOn ? '' : 'Enable a channel first';
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        applyState(msg);
      } else if (msg.type === 'testResult') {
        document.getElementById('testResult').textContent = msg.ok ? 'Sent.' : 'All channels are off - nothing sent.';
      }
    });

    // Tell the extension we're actually loaded and listening - fixes the race
    // where refresh() fires before this script has attached its listener.
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
    }
}

let viewProvider: AlexaNotifyViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    state = context.globalState;

    outputChannel = vscode.window.createOutputChannel('Claude Alexa Notify');
    context.subscriptions.push(outputChannel);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'alexaNotify.toggleEnabled';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    viewProvider = new AlexaNotifyViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AlexaNotifyViewProvider.viewType, viewProvider)
    );

    // Lets Windows route vscode://local.claude-alexa-notify/... URIs here
    // (toast clicks use this), which also brings VS Code to the foreground
    // as part of how the OS invokes a protocol-activated app - no separate
    // "focus" API call is needed, the handler just needs to exist.
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri: vscode.Uri) {
                log(`URI handler invoked: ${uri.toString()}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('alexaNotify.toggleEnabled', async () => {
            const current = getConfig().enabled;
            await setConfigValue('enabled', !current);
            vscode.window.setStatusBarMessage(`Claude Alexa Notify: ${!current ? 'enabled' : 'disabled'}`, 3000);
        })
    );

    startServer(getConfig().port);
    log('Claude Alexa Notify activated');
}

export function deactivate() {
    if (pendingNotificationTimer) { clearTimeout(pendingNotificationTimer); }
    if (reminderTimer) { clearTimeout(reminderTimer); }
    if (server) { server.close(); }
}
