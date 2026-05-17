import * as vscode from 'vscode';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MacroCommand {
  label: string;
  cmd: string;
  desc: string;
  color: string;
  pinned: boolean;
  usageCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COLORS = [
  '#4ec9b0', '#569cd6', '#ce9178',
  '#dcdcaa', '#c586c0', '#9cdcfe',
  '#b5cea8', '#f44747',
];

// Commands that are too noisy to prompt about
const NOISY_CMDS = new Set([
  'ls', 'll', 'la', 'cd', 'pwd', 'clear', 'cls', 'exit',
  'q', 'history', 'cat', 'echo', 'which', 'man',
]);

const DEFAULTS: MacroCommand[] = [
  { label: 'Dev',       cmd: 'npm run dev',            desc: 'Start local dev server on port 5173',    color: '#4ec9b0', pinned: false, usageCount: 0 },
  { label: 'Build',     cmd: 'npm run build',           desc: 'Bundle for production into /dist',        color: '#569cd6', pinned: false, usageCount: 0 },
  { label: 'Test',      cmd: 'npm test -- --watch',    desc: 'Run Jest in watch mode',                  color: '#dcdcaa', pinned: false, usageCount: 0 },
  { label: 'Docker Up', cmd: 'docker-compose up -d',   desc: 'Start all containers in the background', color: '#ce9178', pinned: false, usageCount: 0 },
];

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  let commands: MacroCommand[] = context.globalState.get('macros', DEFAULTS);
  let view: vscode.WebviewView | undefined;

  const save    = () => context.globalState.update('macros', commands);
  const refresh = () => { if (view) view.webview.html = buildHtml(commands); };

  // ── Webview provider ──────────────────────────────────────────────────────

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(wv) {
      view = wv;
      wv.webview.options = { enableScripts: true };
      wv.webview.html = buildHtml(commands);

      wv.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {

          case 'run': {
            // Increment usage count, run in terminal
            commands[msg.index].usageCount++;
            save();
            const t = vscode.window.activeTerminal ?? vscode.window.createTerminal('Macros');
            t.show(true);
            t.sendText(commands[msg.index].cmd);
            refresh();
            break;
          }

          case 'pin': {
            commands[msg.index].pinned = !commands[msg.index].pinned;
            save(); refresh();
            break;
          }

          case 'delete': {
            commands.splice(msg.index, 1);
            save(); refresh();
            break;
          }

          // "Add" button → VS Code native input boxes (prompt() doesn't work in webviews)
          case 'openAdd': {
            const label = await vscode.window.showInputBox({
              title: 'New Macro — Step 1 of 3',
              prompt: 'Button label',
              placeHolder: 'e.g. Dev Server',
            });
            if (!label) break;

            const cmd = await vscode.window.showInputBox({
              title: 'New Macro — Step 2 of 3',
              prompt: 'Shell command to run',
              placeHolder: 'e.g. npm run dev',
            });
            if (!cmd) break;

            const desc = await vscode.window.showInputBox({
              title: 'New Macro — Step 3 of 3',
              prompt: 'Description (shown in info bar on hover)',
              placeHolder: 'e.g. Starts Vite dev server on port 5173',
            });

            commands.push({
              label: label.trim(),
              cmd:   cmd.trim(),
              desc:  (desc ?? '').trim(),
              color: COLORS[commands.length % COLORS.length],
              pinned: false,
              usageCount: 0,
            });
            save(); refresh();
            break;
          }
        }
      });
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('terminalMacroBarView', provider)
  );

  // ── Terminal listener (requires VS Code ≥ 1.84 + shell integration enabled) ─

  if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        const rawCmd = e.execution.commandLine.value.trim();

		if (!rawCmd || rawCmd.length < 3) return;

        // Skip if already saved
        if (commands.some((c) => c.cmd === rawCmd)) return;

        // Skip noisy one-word commands
        const firstWord = rawCmd.split(' ')[0];
        if (NOISY_CMDS.has(firstWord)) return;

        const action = await vscode.window.showInformationMessage(
          `Add "${rawCmd}" to Macro Bar?`,
          'Add', 'Dismiss'
        );
        if (action !== 'Add') return;

        const label = await vscode.window.showInputBox({
          prompt: 'Button label',
          value: firstWord,
        });
        if (!label) return;

        const desc = await vscode.window.showInputBox({
          prompt: 'Description (shown in info bar on hover)',
          placeHolder: 'What does this command do?',
        });

        commands.push({
          label: label.trim(),
          cmd:   rawCmd,
          desc:  (desc ?? '').trim(),
          color: COLORS[commands.length % COLORS.length],
          pinned: false,
          usageCount: 1,
        });
        save(); refresh();
      })
    );
  }
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

/**
 * Layout: Two rows.
 *
 * Row 1 (30px)  — [MACROS label | scrollable chips | + Add]
 * Row 2 (26px)  — Sticky info bar: shows cmd + description of last hovered chip
 *                 with Pin / Remove buttons on the right
 *
 * Why info bar instead of a tooltip?
 * Tooltips with position:fixed are relative to the webview iframe and get
 * clipped by the scrollable row's overflow. The info bar lives below the
 * scroll container so it's never clipped and always readable.
 */
function buildHtml(cmds: MacroCommand[]): string {

  // Sort: pinned first → then by usage count descending
  const sorted = cmds
    .map((c, i) => ({ ...c, originalIndex: i }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.usageCount - a.usageCount;
    });

  const chips = sorted.map((c) => `
    <div class="chip ${c.pinned ? 'pinned' : ''}"
      data-index="${c.originalIndex}"
      data-cmd="${esc(c.cmd)}"
      data-desc="${esc(c.desc || 'No description')}"
      data-pinned="${c.pinned}"
      title=""
    >
      <span class="dot" style="background:${c.color}"></span>
      ${c.pinned ? '<span class="pin-mark">⊤</span>' : ''}
      <span class="chip-label">${esc(c.label)}</span>
      ${c.usageCount > 0 ? `<span class="badge">${c.usageCount}</span>` : ''}
    </div>
  `).join('');

  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 11px;
    background: var(--vscode-panel-background);
    color: var(--vscode-foreground);
    overflow: hidden;
    user-select: none;
  }

  /* ── Top bar ── */
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    height: 30px;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
  }

  .bar-label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    padding-right: 6px;
    border-right: 1px solid var(--vscode-widget-border);
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .scroll {
    display: flex;
    gap: 5px;
    overflow-x: auto;
    flex: 1;
    align-items: center;
    scrollbar-width: thin;
    scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
  }
  .scroll::-webkit-scrollbar { height: 2px; }
  .scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 1px; }

  /* ── Chip ── */
  .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-widget-border);
    color: var(--vscode-foreground);
    white-space: nowrap;
    font-size: 11px;
    font-family: monospace;
    flex-shrink: 0;
    transition: background 0.1s, border-color 0.1s;
  }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  .chip.pinned { border-color: var(--vscode-focusBorder); }
  .chip.flash  { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

  .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  .pin-mark { font-size: 9px; color: var(--vscode-focusBorder); }

  .badge {
    font-size: 9px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 8px;
    padding: 0 4px;
    font-family: var(--vscode-font-family);
    min-width: 14px;
    text-align: center;
  }

  /* ── Add button ── */
  .add-btn {
    padding: 2px 8px;
    background: none;
    border: 1px dashed var(--vscode-widget-border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    flex-shrink: 0;
    font-family: var(--vscode-font-family);
  }
  .add-btn:hover { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }

  /* ── Info bar (replaces tooltip — no clipping issues) ── */
  .info-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    height: 26px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    transition: opacity 0.15s;
  }
  .info-bar.empty { opacity: 0.35; }

  .info-cmd {
    font-family: monospace;
    font-size: 10px;
    color: #9cdcfe;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 180px;
    flex-shrink: 0;
  }
  .info-dot { color: var(--vscode-descriptionForeground); font-size: 10px; flex-shrink: 0; }
  .info-desc {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .info-actions { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
  .info-btn {
    background: none;
    border: 1px solid;
    cursor: pointer;
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    line-height: 16px;
  }
  .btn-pin { color: var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  .btn-pin:hover { background: var(--vscode-focusBorder); color: var(--vscode-button-foreground); }
  .btn-del { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .btn-del:hover { background: var(--vscode-errorForeground); color: #fff; }
</style>
</head>
<body>

<!-- Row 1: chip bar -->
<div class="bar">
  <span class="bar-label">MACROS</span>
  <div class="scroll" id="scroll">${chips}</div>
  <button class="add-btn" id="addBtn">+ Add</button>
</div>

<!-- Row 2: sticky info bar -->
<div class="info-bar empty" id="infoBar">
  <span class="info-cmd"  id="infoCmd">—</span>
  <span class="info-dot">·</span>
  <span class="info-desc" id="infoDesc">Hover a command to see details</span>
  <div class="info-actions" id="infoActions" style="visibility:hidden">
    <button class="info-btn btn-pin" id="pinBtn">Pin</button>
    <button class="info-btn btn-del" id="delBtn">Remove</button>
  </div>
</div>

<script>
  const vsc = acquireVsCodeApi();
  let activeIndex = -1;
  let activePinned = false;

  // ── Chip interactions ──────────────────────────────────────────────────────

  document.querySelectorAll('.chip').forEach(chip => {
    const idx    = parseInt(chip.dataset.index, 10);
    const cmd    = chip.dataset.cmd;
    const desc   = chip.dataset.desc;
    const pinned = chip.dataset.pinned === 'true';

    // Hover → update info bar (sticky, doesn't hide on mouseleave)
    chip.addEventListener('mouseenter', () => {
      activeIndex  = idx;
      activePinned = pinned;

      document.getElementById('infoBar').classList.remove('empty');
      document.getElementById('infoCmd').textContent  = '$ ' + cmd;
      document.getElementById('infoDesc').textContent = desc || 'No description';
      document.getElementById('infoActions').style.visibility = 'visible';
      document.getElementById('pinBtn').textContent = pinned ? 'Unpin' : 'Pin';
    });

    // Click → run command, flash chip
    chip.addEventListener('click', () => {
      chip.classList.add('flash');
      setTimeout(() => chip.classList.remove('flash'), 200);
      vsc.postMessage({ type: 'run', index: idx });
    });
  });

  // ── Info bar buttons ───────────────────────────────────────────────────────

  document.getElementById('pinBtn').addEventListener('click', () => {
    if (activeIndex < 0) return;
    vsc.postMessage({ type: 'pin', index: activeIndex });
  });

  document.getElementById('delBtn').addEventListener('click', () => {
    if (activeIndex < 0) return;
    vsc.postMessage({ type: 'delete', index: activeIndex });
  });

  // ── Add button → triggers VS Code native input boxes ─────────────────────

  document.getElementById('addBtn').addEventListener('click', () => {
    vsc.postMessage({ type: 'openAdd' });
  });
</script>
</body>
</html>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

