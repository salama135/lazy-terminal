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
  let codiconsUri = '';
  const refresh = () => { if (view) view.webview.html = buildHtml(commands, envVars, codiconsUri); };

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
      wv.webview.options = {
        enableScripts: true,
        localResourceRoots: [context.extensionUri],
      };
      codiconsUri = wv.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
      ).toString();
      wv.webview.html = buildHtml(commands, envVars, codiconsUri);

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

function buildHtml(cmds: MacroCommand[], envVars: EnvVar[], codiconsUri: string): string {

  const sorted = cmds
    .map((c, i) => ({ ...c, originalIndex: i }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.usageCount - a.usageCount;
    });

    const runSvg = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M4.74514 3.06414C4.41183 2.87665 4 3.11751 4 3.49993V12.5002C4 12.8826 4.41182 13.1235 4.74512 12.936L12.7454 8.43601C13.0852 8.24486 13.0852 7.75559 12.7454 7.56443L4.74514 3.06414ZM3 3.49993C3 2.35268 4.2355 1.63011 5.23541 2.19257L13.2357 6.69286C14.2551 7.26633 14.2551 8.73415 13.2356 9.30759L5.23537 13.8076C4.23546 14.37 3 13.6474 3 12.5002V3.49993Z"/></svg>`;
    const runAboveSvg = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M15.854 11.853C15.756 11.95 15.628 11.999 15.5 11.999C15.372 11.999 15.244 11.951 15.146 11.853L14 10.707V15.5C14 15.776 13.776 16 13.5 16C13.224 16 13 15.776 13 15.5V10.707L11.854 11.853C11.659 12.048 11.342 12.048 11.147 11.853C10.952 11.658 10.952 11.341 11.147 11.146L13.147 9.14601C13.342 8.95101 13.659 8.95101 13.854 9.14601L15.854 11.146C16.049 11.341 16.049 11.658 15.854 11.853ZM4 12.5V3.50001C4 3.11801 4.412 2.87701 4.745 3.06401L12.745 7.56401C12.915 7.66001 13 7.83001 13 8.00001H14C14 7.49001 13.745 6.97901 13.235 6.69301L5.235 2.19301C4.235 1.63101 3 2.35301 3 3.50001V12.5C3 13.647 4.235 14.37 5.235 13.807L10 11.127V9.98001L4.745 12.936C4.412 13.124 4 12.883 4 12.5Z"/></svg>`;
    const pinSvg = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13.5 3C13.303 3 13.109 3.038 12.923 3.114L8.481 4.967L5.659 4.026C5.505 3.976 5.339 4.001 5.209 4.095C5.078 4.189 5.001 4.339 5.001 4.5V7H1.257L0.5 7.5L1.257 8H5V10.5C5 10.661 5.077 10.812 5.208 10.905C5.338 11 5.504 11.023 5.658 10.974L8.48 10.033L12.925 11.887C13.109 11.962 13.302 12 13.499 12C14.326 12 14.999 11.327 14.999 10.5V4.5C14.999 3.673 14.326 3 13.499 3H13.5ZM14 10.5C14 10.843 13.615 11.09 13.308 10.962L8.693 9.038C8.631 9.013 8.566 9 8.501 9C8.447 9 8.395 9.009 8.343 9.025L6.001 9.806V5.193L8.343 5.974C8.457 6.011 8.581 6.007 8.694 5.961L13.306 4.038C13.629 3.902 14.001 4.156 14.001 4.499V10.499L14 10.5Z"/></svg>`;
    const pinnedSvg = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z"/></svg>`;
    const unpinSvg = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9.56016 10.2673L14.1464 14.8536C14.3417 15.0488 14.6583 15.0488 14.8536 14.8536C15.0488 14.6583 15.0488 14.3417 14.8536 14.1464L1.85355 1.14645C1.65829 0.951184 1.34171 0.951184 1.14645 1.14645C0.951184 1.34171 0.951184 1.65829 1.14645 1.85355L5.73223 6.43934L5.6526 6.58876L2.8419 7.52566C2.6775 7.58046 2.5532 7.71648 2.51339 7.88513C2.47357 8.05378 2.52392 8.23102 2.64646 8.35356L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5264 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L9.56016 10.2673ZM8.82138 9.52849L8.76403 9.5592C8.65137 9.61951 8.56608 9.72066 8.52567 9.84189L7.7815 12.0744L3.92562 8.21851L6.15812 7.47435C6.27966 7.43383 6.38101 7.34822 6.44126 7.23516L6.47143 7.17854L8.82138 9.52849ZM12.7178 7.4426L10.6636 8.54227L11.4024 9.28105L13.1897 8.32422C14.0759 7.84981 14.2538 6.65509 13.5443 5.94304L10.0589 2.44509C9.34701 1.73062 8.14697 1.90828 7.67261 2.79838L6.71556 4.59421L7.45476 5.33341L8.55511 3.26869C8.71323 2.97199 9.11324 2.91277 9.35055 3.15093L12.836 6.64888C13.0725 6.88623 13.0131 7.28446 12.7178 7.4426Z"/></svg>`;
    const trashSvg = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M14 2H10C10 0.897 9.103 0 8 0C6.897 0 6 0.897 6 2H2C1.724 2 1.5 2.224 1.5 2.5C1.5 2.776 1.724 3 2 3H2.54L3.349 12.708C3.456 13.994 4.55 15 5.84 15H10.159C11.449 15 12.543 13.993 12.65 12.708L13.459 3H13.999C14.275 3 14.499 2.776 14.499 2.5C14.499 2.224 14.275 2 13.999 2H14ZM8 1C8.551 1 9 1.449 9 2H7C7 1.449 7.449 1 8 1ZM11.655 12.625C11.591 13.396 10.934 14 10.16 14H5.841C5.067 14 4.41 13.396 4.346 12.625L3.544 3H12.458L11.656 12.625H11.655ZM7 5.5V11.5C7 11.776 6.776 12 6.5 12C6.224 12 6 11.776 6 11.5V5.5C6 5.224 6.224 5 6.5 5C6.776 5 7 5.224 7 5.5ZM10 5.5V11.5C10 11.776 9.776 12 9.5 12C9.224 12 9 11.776 9 11.5V5.5C9 5.224 9.224 5 9.5 5C9.776 5 10 5.224 10 5.5Z"/></svg>`;


  // ── Chips (row 1) ──
  const chips = sorted.map(c => `
    <div class="chip${c.pinned ? ' pinned' : ''}" data-index="${c.originalIndex}">
      <span class="dot" style="background:${c.color}"></span>
      ${c.pinned ? pinnedSvg : ''}
      <span class="chip-label">${esc(c.label)}</span>
      ${c.usageCount > 0 ? `<span class="badge">${c.usageCount}</span>` : ''}
    </div>
  `).join('');

  // ── Command list rows (row 2) ──
  const rows = sorted.length
    ? sorted.map(c => `
      <div class="row${c.pinned ? ' pinned' : ''}">
        <span class="row-dot" style="background:${c.color}"></span>
        <span class="row-label">${esc(c.label)}${c.pinned ? ` ${pinnedSvg}` : ''}</span>
        <span class="row-cmd">${esc(c.cmd)}</span>
        <span class="row-desc">${esc(c.desc || '—')}</span>
        <div class="row-actions">
          <button class="row-btn btn-run"  data-index="${c.originalIndex}" title="Run">${runSvg}</button>
          <button class="row-btn btn-args" data-index="${c.originalIndex}" title="Run with args">${runAboveSvg}</button>
          <button class="row-btn btn-pin" data-index="${c.originalIndex}" title="${c.pinned ? 'Unpin' : 'Pin'}">${c.pinned ? unpinSvg : pinnedSvg}</button>
          <button class="row-btn btn-del"  data-index="${c.originalIndex}" title="Remove">${trashSvg}</button>
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
        <button class="env-del" data-index="${i}" title="Remove"><span class="codicon codicon-close"></span></button>
      </div>`).join('')
    : `<span class="env-empty">No env vars. Add one to use as <code>$KEY</code> in commands.</span>`;

  return /* html */`<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline' vscode-resource:; font-src vscode-resource:; script-src 'unsafe-inline';">
<link rel="stylesheet" href="${codiconsUri}" />
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
  .env-key { color: #00a6ff; min-width: 80px; font-weight: 600; }
  .env-eq  { color: var(--vscode-descriptionForeground); }
  .env-val { color: #c95427; flex: 1; }
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
    color: #22b2ff;
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
    grid-template-columns: 6px 55px minmax(80px,1fr) minmax(60px,1fr) 80px;
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
    grid-template-columns: 6px 55px minmax(80px,1fr) minmax(60px,1fr) 80px;
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
    color: #04a0fa;
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

  .row-actions { display: flex; gap: 2px; overflow: hidden; }

  .row-btn {
    background: none;
    border: 1px solid;
    cursor: pointer;
    font-size: 9px;
    padding: 1px 3px;
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    line-height: 14px;
    opacity: 0.65;
    white-space: nowrap;
    width: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .row-btn:hover { opacity: 1; }

  .btn-run  { color: #00c49c; border-color: #4ec9b0; }
  .btn-run:hover  { background: #00c49c; color: #1e1e1e; }
  .btn-args { color: #8643f3; border-color: #ab7ff3; }
  .btn-args:hover { background: #8643f3; color: #1e1e1e; }
  .btn-pin  { color: var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  .btn-pin:hover  { background: var(--vscode-focusBorder); color: var(--vscode-button-foreground); }
  .btn-del  { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .btn-del:hover  { background: var(--vscode-errorForeground); color: #fff; }

  .codicon { font-size: 14px !important; vertical-align: middle; }
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