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

interface EnvVar {
  key: string;
  value: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COLORS = [
  '#4ec9b0', '#569cd6', '#ce9178',
  '#dcdcaa', '#c586c0', '#9cdcfe',
  '#b5cea8', '#f44747',
];

const NOISY_CMDS = new Set([
  'ls', 'll', 'la', 'cd', 'pwd', 'clear', 'cls', 'exit',
  'q', 'history', 'cat', 'echo', 'which', 'man',
]);

const DEFAULTS: MacroCommand[] = [
  { label: 'Dev',       cmd: 'npm run dev',           desc: 'Start local dev server on port 5173',    color: '#4ec9b0', pinned: false, usageCount: 0 },
  { label: 'Build',     cmd: 'npm run build',          desc: 'Bundle for production into /dist',        color: '#569cd6', pinned: false, usageCount: 0 },
  { label: 'Test',      cmd: 'npm test -- --watch',   desc: 'Run Jest in watch mode',                  color: '#dcdcaa', pinned: false, usageCount: 0 },
  { label: 'Docker Up', cmd: 'docker-compose up -d',  desc: 'Start all containers in the background', color: '#ce9178', pinned: false, usageCount: 0 },
];

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  let commands: MacroCommand[] = context.globalState.get('macros', DEFAULTS);
  let envVars: EnvVar[]        = context.globalState.get('macroEnvVars', []);
  let view: vscode.WebviewView | undefined;

  const save    = () => {
    context.globalState.update('macros', commands);
    context.globalState.update('macroEnvVars', envVars);
  };
  const refresh = () => { if (view) view.webview.html = buildHtml(commands, envVars); };

  /** Replace $KEY / ${KEY} recursively — e.g. URL=localhost:$PORT resolves $PORT too.
   *  Loops until stable or 10 iterations (guards against circular refs like A=$B B=$A). */
  const resolveEnv = (cmd: string): string => {
    let result = cmd;
    for (let i = 0; i < 10; i++) {
      const next = envVars.reduce((acc, { key, value }) =>
        acc.replace(new RegExp(`\\$\\{${key}\\}|\\$${key}\\b`, 'g'), value), result);
      if (next === result) break; // stable — nothing left to substitute
      result = next;
    }
    return result;
  };

  // ── Webview provider ──────────────────────────────────────────────────────

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(wv) {
      view = wv;
      wv.webview.options = { enableScripts: true };
      wv.webview.html = buildHtml(commands, envVars);

      wv.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {

          case 'run': {
            commands[msg.index].usageCount++;
            save();
            const t = vscode.window.activeTerminal ?? vscode.window.createTerminal('Macros');
            t.show(true);
            t.sendText(resolveEnv(commands[msg.index].cmd));
            refresh();
            break;
          }

          case 'runWithArgs': {
            const macro = commands[msg.index];
            const envHint = envVars.length
              ? `Available: ${envVars.map(e => `$${e.key}`).join(', ')}`
              : 'No env vars defined yet';

            const args = await vscode.window.showInputBox({
              title: `Run "${macro.label}" with args`,
              prompt: `Extra args to append to: ${macro.cmd}`,
              placeHolder: `e.g. --port 3001   or   --env $MY_VAR   (${envHint})`,
            });
            if (args === undefined) break; // user cancelled

            commands[msg.index].usageCount++;
            save();
            const finalCmd = resolveEnv(`${macro.cmd} ${args}`.trimEnd());
            const t = vscode.window.activeTerminal ?? vscode.window.createTerminal('Macros');
            t.show(true);
            t.sendText(finalCmd);
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

          case 'openAdd': {
            const label = await vscode.window.showInputBox({
              title: 'New Macro — Step 1 of 3',
              prompt: 'Button label',
              placeHolder: 'e.g. Dev Server',
            });
            if (!label) break;

            const envHint = envVars.length
              ? `Tip: use $${envVars[0].key} (and others) as placeholders`
              : 'Tip: define ENV vars to use as $KEY placeholders';
            const cmd = await vscode.window.showInputBox({
              title: 'New Macro — Step 2 of 3',
              prompt: `Shell command. ${envHint}`,
              placeHolder: 'e.g. npm run dev -- --port $PORT',
            });
            if (!cmd) break;

            const desc = await vscode.window.showInputBox({
              title: 'New Macro — Step 3 of 3',
              prompt: 'Short description',
              placeHolder: 'e.g. Starts Vite dev server',
            });

            commands.push({
              label:      label.trim(),
              cmd:        cmd.trim(),
              desc:       (desc ?? '').trim(),
              color:      COLORS[commands.length % COLORS.length],
              pinned:     false,
              usageCount: 0,
            });
            save(); refresh();
            break;
          }

          case 'addEnv': {
            const key = await vscode.window.showInputBox({
              title: 'Add Env Var — Step 1 of 2',
              prompt: 'Variable name (used as $NAME in commands)',
              placeHolder: 'e.g. PORT',
              validateInput: v => /^[A-Z_][A-Z0-9_]*$/i.test(v.trim())
                ? undefined
                : 'Letters, numbers, underscores only',
            });
            if (!key) break;

            const value = await vscode.window.showInputBox({
              title: `Add Env Var — Step 2 of 2`,
              prompt: `Value for $${key.trim()}`,
              placeHolder: 'e.g. 3000',
            });
            if (value === undefined) break;

            const existing = envVars.findIndex(e => e.key === key.trim());
            if (existing >= 0) {
              envVars[existing].value = value.trim();
            } else {
              envVars.push({ key: key.trim(), value: value.trim() });
            }
            save(); refresh();
            break;
          }

          case 'deleteEnv': {
            envVars.splice(msg.index, 1);
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

  // ── Terminal listener ──────────────────────────────────────────────────────

  if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        const rawCmd = e.execution.commandLine.value.trim();
        if (!rawCmd || rawCmd.length < 3) return;
        if (commands.some(c => c.cmd === rawCmd)) return;
        const firstWord = rawCmd.split(' ')[0];
        if (NOISY_CMDS.has(firstWord)) return;

        const action = await vscode.window.showInformationMessage(
          `Add "${rawCmd}" to Macro Bar?`, 'Add', 'Dismiss'
        );
        if (action !== 'Add') return;

        const label = await vscode.window.showInputBox({
          prompt: 'Button label',
          value: firstWord,
        });
        if (!label) return;

        const desc = await vscode.window.showInputBox({
          prompt: 'Description',
          placeHolder: 'What does this command do?',
        });

        commands.push({
          label:      label.trim(),
          cmd:        rawCmd,
          desc:       (desc ?? '').trim(),
          color:      COLORS[commands.length % COLORS.length],
          pinned:     false,
          usageCount: 1,
        });
        save(); refresh();
      })
    );
  }
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildHtml(cmds: MacroCommand[], envVars: EnvVar[]): string {

  const sorted = cmds
    .map((c, i) => ({ ...c, originalIndex: i }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.usageCount - a.usageCount;
    });

  // ── Chips (row 1) ──
  const chips = sorted.map(c => `
    <div class="chip${c.pinned ? ' pinned' : ''}" data-index="${c.originalIndex}">
      <span class="dot" style="background:${c.color}"></span>
      ${c.pinned ? '<span class="pin-mark">⊤</span>' : ''}
      <span class="chip-label">${esc(c.label)}</span>
      ${c.usageCount > 0 ? `<span class="badge">${c.usageCount}</span>` : ''}
    </div>
  `).join('');

  // ── Command list rows (row 2) ──
  const rows = sorted.length
    ? sorted.map(c => `
      <div class="row${c.pinned ? ' pinned' : ''}">
        <span class="row-dot" style="background:${c.color}"></span>
        <span class="row-label">${esc(c.label)}${c.pinned ? ' <span class="pin-icon">⊤</span>' : ''}</span>
        <span class="row-cmd">${esc(c.cmd)}</span>
        <span class="row-desc">${esc(c.desc || '—')}</span>
        <div class="row-actions">
          <button class="row-btn btn-run"  data-index="${c.originalIndex}" title="Run">▶</button>
          <button class="row-btn btn-args" data-index="${c.originalIndex}" title="Run with extra args">▶+</button>
          <button class="row-btn btn-pin"  data-index="${c.originalIndex}" title="${c.pinned ? 'Unpin' : 'Pin'}">${c.pinned ? '↓' : '↑'}</button>
          <button class="row-btn btn-del"  data-index="${c.originalIndex}" title="Remove">✕</button>
        </div>
      </div>`).join('')
    : `<div class="empty-state">No macros yet — click <strong>+ Add</strong> to create one.</div>`;

  // ── Env var rows ──
  const envRows = envVars.length
    ? envVars.map((e, i) => `
      <div class="env-row">
        <span class="env-key">$${esc(e.key)}</span>
        <span class="env-eq">=</span>
        <span class="env-val">${esc(e.value)}</span>
        <button class="env-del" data-index="${i}" title="Remove">✕</button>
      </div>`).join('')
    : `<span class="env-empty">No env vars. Add one to use as <code>$KEY</code> in commands.</span>`;

  return /* html */`<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 11px;
    background: var(--vscode-panel-background);
    color: var(--vscode-foreground);
    overflow: hidden;
    user-select: none;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  /* ── Chip bar ─────────────────────────── */
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    height: 30px;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    flex-shrink: 0;
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

  .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-widget-border);
    white-space: nowrap;
    font-size: 11px;
    font-family: monospace;
    flex-shrink: 0;
    transition: background 0.1s;
  }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  .chip.pinned { border-color: var(--vscode-focusBorder); }
  .chip.flash  { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

  .dot       { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .pin-mark  { font-size: 9px; color: var(--vscode-focusBorder); }
  .badge {
    font-size: 9px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 8px;
    padding: 0 4px;
    min-width: 14px;
    text-align: center;
  }

  /* ── Toolbar buttons ──────────────────── */
  .bar-btn {
    padding: 2px 8px;
    background: none;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    flex-shrink: 0;
    font-family: var(--vscode-font-family);
  }
  .bar-btn:hover  { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  .bar-btn.active { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
  .add-btn { border-style: dashed; }

  /* ── Env panel ────────────────────────── */
  .env-panel {
    display: none;
    flex-direction: column;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    flex-shrink: 0;
    max-height: 130px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
  }
  .env-panel.open { display: flex; }

  .env-header {
    display: flex;
    align-items: center;
    padding: 3px 8px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--vscode-widget-border);
    flex-shrink: 0;
    position: sticky;
    top: 0;
    background: inherit;
  }
  .env-header-title { flex: 1; }

  .env-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    font-family: monospace;
    font-size: 10px;
    border-bottom: 1px solid var(--vscode-widget-border);
  }
  .env-row:last-child { border-bottom: none; }
  .env-row:hover { background: var(--vscode-list-hoverBackground); }
  .env-key { color: #9cdcfe; min-width: 80px; font-weight: 600; }
  .env-eq  { color: var(--vscode-descriptionForeground); }
  .env-val { color: #ce9178; flex: 1; }
  .env-del {
    background: none; border: none; cursor: pointer;
    color: var(--vscode-errorForeground); font-size: 10px;
    padding: 0 3px; opacity: 0.5; line-height: 1;
  }
  .env-del:hover { opacity: 1; }
  .env-empty {
    padding: 5px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    font-style: italic;
  }
  .env-empty code {
    font-family: monospace;
    color: #9cdcfe;
    font-style: normal;
  }

  /* ── Command list ─────────────────────── */
  .list {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
  }
  .list::-webkit-scrollbar { width: 3px; }
  .list::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 1px; }

  .list-header {
    display: grid;
    grid-template-columns: 6px 65px minmax(100px,1fr) minmax(80px,1fr) 94px;
    gap: 8px;
    padding: 3px 8px;
    font-size: 9px;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    position: sticky;
    top: 0;
    text-transform: uppercase;
  }

  .row {
    display: grid;
    grid-template-columns: 6px 65px minmax(100px,1fr) minmax(80px,1fr) 94px;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
    min-height: 26px;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.pinned { border-left: 2px solid var(--vscode-focusBorder); padding-left: 6px; }

  .row-dot { width: 6px; height: 6px; border-radius: 50%; }

  .row-label {
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pin-icon { font-size: 9px; color: var(--vscode-focusBorder); }

  .row-cmd {
    font-family: monospace;
    font-size: 10px;
    color: #9cdcfe;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-desc {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-actions { display: flex; gap: 3px; }

  .row-btn {
    background: none;
    border: 1px solid;
    cursor: pointer;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    line-height: 14px;
    opacity: 0.65;
    white-space: nowrap;
  }
  .row-btn:hover { opacity: 1; }

  .btn-run  { color: #4ec9b0; border-color: #4ec9b0; }
  .btn-run:hover  { background: #4ec9b0; color: #1e1e1e; }
  .btn-args { color: #dcdcaa; border-color: #dcdcaa; }
  .btn-args:hover { background: #dcdcaa; color: #1e1e1e; }
  .btn-pin  { color: var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  .btn-pin:hover  { background: var(--vscode-focusBorder); color: var(--vscode-button-foreground); }
  .btn-del  { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .btn-del:hover  { background: var(--vscode-errorForeground); color: #fff; }

  .empty-state {
    padding: 12px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    text-align: center;
  }
</style>
</head>
<body>

<!-- Row 1: chip bar -->
<div class="bar">
  <span class="bar-label">MACROS</span>
  <div class="scroll" id="scroll">${chips}</div>
  <button class="bar-btn" id="envBtn">ENV${envVars.length ? ` (${envVars.length})` : ''}</button>
  <button class="bar-btn add-btn" id="addBtn">+ Add</button>
</div>

<!-- Env panel (toggleable) -->
<div class="env-panel" id="envPanel">
  <div class="env-header">
    <span class="env-header-title">ENV VARS — reference in commands as $KEY</span>
    <button class="bar-btn" id="addEnvBtn" style="font-size:9px;padding:1px 6px;border-style:dashed">+ Add</button>
  </div>
  ${envRows}
</div>

<!-- Row 2: command list -->
<div class="list">
  <div class="list-header">
    <span></span>
    <span>Name</span>
    <span>Command</span>
    <span>Description</span>
    <span>Actions</span>
  </div>
  ${rows}
</div>

<script>
  const vsc = acquireVsCodeApi();

  // Chips → run
  document.querySelectorAll('.chip').forEach(chip => {
    const idx = parseInt(chip.dataset.index, 10);
    chip.addEventListener('click', () => {
      chip.classList.add('flash');
      setTimeout(() => chip.classList.remove('flash'), 200);
      vsc.postMessage({ type: 'run', index: idx });
    });
  });

  // List row buttons
  document.querySelectorAll('.btn-run').forEach(btn =>
    btn.addEventListener('click', () => vsc.postMessage({ type: 'run', index: +btn.dataset.index })));

  document.querySelectorAll('.btn-args').forEach(btn =>
    btn.addEventListener('click', () => vsc.postMessage({ type: 'runWithArgs', index: +btn.dataset.index })));

  document.querySelectorAll('.btn-pin').forEach(btn =>
    btn.addEventListener('click', () => vsc.postMessage({ type: 'pin', index: +btn.dataset.index })));

  document.querySelectorAll('.btn-del').forEach(btn =>
    btn.addEventListener('click', () => vsc.postMessage({ type: 'delete', index: +btn.dataset.index })));

  // Env panel toggle
  const envPanel = document.getElementById('envPanel');
  const envBtn   = document.getElementById('envBtn');
  envBtn.addEventListener('click', () => {
    const open = envPanel.classList.toggle('open');
    envBtn.classList.toggle('active', open);
  });

  // Env: delete
  document.querySelectorAll('.env-del').forEach(btn =>
    btn.addEventListener('click', () => vsc.postMessage({ type: 'deleteEnv', index: +btn.dataset.index })));

  // Env: add
  document.getElementById('addEnvBtn').addEventListener('click', () =>
    vsc.postMessage({ type: 'addEnv' }));

  // Add macro
  document.getElementById('addBtn').addEventListener('click', () =>
    vsc.postMessage({ type: 'openAdd' }));
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