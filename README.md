# Claude Code Notifications

Get a notification when Claude Code needs your input or finishes a turn, even
when you are not looking at VS Code.

Two channels are included:

| Channel | What you get | What you need |
|---|---|---|
| Windows toast (on by default) | A Windows notification in the corner of the screen. Click it to bring VS Code to the front. | Nothing extra. |
| Alexa (off by default) | Your Echo speaks the message out loud. | An Amazon Echo and a free Voice Monkey account. |

You don't get a notification when you are already at the keyboard with VS Code
in focus. Several prompts in a row give you one notification, not many. If you
answer within 3 seconds, no notification fires at all.

**Requirements:** Windows 10 or 11, VS Code, Claude Code running in VS Code.
To build from source you also need Node.js. You don't need it if you use the
prebuilt package.

## What's in this repo

```
README.md                     <- this file
SETUP-PROMPT.txt              <- paste into Claude Code to run the whole setup
claude-notify-setup/          <- a Claude Code skill
  SKILL.md                    <- step-by-step setup that Claude follows
  MANUAL.md                   <- full reference: design, every channel, troubleshooting table
  claude-alexa-notify-0.1.0.vsix   <- prebuilt VS Code extension
  assets/                     <- extension source code, to rebuild if needed
```

## Install (recommended: let Claude Code do it)

1. Get the files. Either run:
   ```
   git clone https://github.com/naman-solvas/claude-code-notify.git
   ```
   or, on GitHub, click **Code** > **Download ZIP** and unzip it.
2. Open `SETUP-PROMPT.txt`. In the first line of the prompt, put the folder
   you cloned or unzipped to.
3. Start a new Claude Code chat in VS Code and paste the prompt.
4. Claude copies the skill into `%USERPROFILE%\.claude\skills\`, asks which
   channels you want, then installs the extension and adds the hooks to your
   `~/.claude/settings.json`. Approve each step when it asks.
5. When Claude asks you to, run **Developer: Reload Window** from the Command
   Palette (`Ctrl+Shift+P`).
6. Click the new speaker icon in the VS Code activity bar, then click **Send
   test announcement**.

After the first setup, the skill stays installed. To run it again later, type
`/claude-notify-setup` in Claude Code.

## Install manually

Follow `claude-notify-setup/SKILL.md` steps 3 to 6 yourself. The short version:

1. `code --install-extension claude-notify-setup\claude-alexa-notify-0.1.0.vsix --force`
2. Add the four hooks from SKILL.md step 4 to `%USERPROFILE%\.claude\settings.json`.
   Merge them with what is already there. Don't replace the file.
3. Reload the VS Code window.

## If something doesn't work

- **No toast appears:** your machine may register VS Code under a different
  app ID. See SKILL.md step 5. It has a one-line command that finds the right ID.
- **The .vsix file won't install:** build from source instead, as described in
  SKILL.md step 3.
- **Anything else:** look up the symptom in the table in MANUAL.md section 7.
  Every error we hit while building this is listed with its cause and fix.

## Privacy

Nothing in this repo contains anyone's credentials. The extension listens
only on `127.0.0.1`, so other machines can't reach it. The Windows toast makes
no network calls. If you turn on Alexa, your Voice Monkey token is stored in a
local file, `~/.claude/voicemonkey-token.txt`. Don't share that file.
