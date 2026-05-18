import * as vscode from 'vscode';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MacroCommand {
  label: string;
  cmd: string;
  desc: string;
  color: string;
  pinned: boolean;
  usageCount: number;
  group: string;
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
  { label: 'Dev',       cmd: 'npm run dev',           desc: 'Start local dev server',              color: '#4ec9b0', pinned: false, usageCount: 0, group: 'npm'    },
  { label: 'Build',     cmd: 'npm run build',          desc: 'Bundle for production',               color: '#569cd6', pinned: false, usageCount: 0, group: 'npm'    },
  { label: 'Test',      cmd: 'npm test -- --watch',   desc: 'Run Jest in watch mode',              color: '#dcdcaa', pinned: false, usageCount: 0, group: 'npm'    },
  { label: 'Docker Up', cmd: 'docker-compose up -d',  desc: 'Start all containers in background',  color: '#ce9178', pinned: false, usageCount: 0, group: 'docker' },
];

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // Migrate old macros that may be missing the group field
  let commands: MacroCommand[] = (context.globalState.get<MacroCommand[]>('macros', DEFAULTS))
    .map(c => ({ ...c, group: c.group ?? '' }));

  let envVars: EnvVar[] = context.globalState.get('macroEnvVars', []);
  let view: vscode.WebviewView | undefined;
  let codiconsUri = '';

  const save    = () => {
    context.globalState.update('macros', commands);
    context.globalState.update('macroEnvVars', envVars);
  };
  const refresh = () => { if (view) view.webview.html = buildHtml(commands, envVars, codiconsUri); };

  /** Resolve $KEY / ${KEY} recursively — handles chained vars up to 10 passes */
  const resolveEnv = (cmd: string): string => {
    let result = cmd;
    for (let i = 0; i < 10; i++) {
      const next = envVars.reduce((acc, { key, value }) =>
        acc.replace(new RegExp(`\\$\\{${key}\\}|\\$${key}\\b`, 'g'), value), result);
      if (next === result) break;
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

          // ── Run ──────────────────────────────────────────────────────────
          case 'run': {
            commands[msg.index].usageCount++;
            save();
            const t = vscode.window.activeTerminal ?? vscode.window.createTerminal('Macros');
            t.show(true);
            t.sendText(resolveEnv(commands[msg.index].cmd));
            refresh();
            break;
          }

          // ── Run with args ─────────────────────────────────────────────────
          case 'runWithArgs': {
            const macro = commands[msg.index];
            const envHint = envVars.length
              ? `Available: ${envVars.map(e => `$${e.key}`).join(', ')}`
              : 'No env vars defined yet';
            const args = await vscode.window.showInputBox({
              title: `Run "${macro.label}" with args`,
              prompt: `Extra args appended to: ${macro.cmd}`,
              placeHolder: `e.g. --port 3001  (${envHint})`,
            });
            if (args === undefined) break;
            commands[msg.index].usageCount++;
            save();
            const t = vscode.window.activeTerminal ?? vscode.window.createTerminal('Macros');
            t.show(true);
            t.sendText(resolveEnv(`${macro.cmd} ${args}`.trimEnd()));
            refresh();
            break;
          }

          // ── Copy command ──────────────────────────────────────────────────
          case 'copyCmd': {
            const resolved = resolveEnv(commands[msg.index].cmd);
            await vscode.env.clipboard.writeText(resolved);
            vscode.window.setStatusBarMessage(`$(clippy) Copied: ${resolved}`, 3000);
            break;
          }

          // ── Edit macro ────────────────────────────────────────────────────
          case 'openEdit': {
            const macro = commands[msg.index];

            const label = await vscode.window.showInputBox({
              title: `Edit "${macro.label}" — 1 of 4`, prompt: 'Button label', value: macro.label,
            });
            if (label === undefined) break;

            const cmd = await vscode.window.showInputBox({
              title: `Edit "${macro.label}" — 2 of 4`, prompt: 'Shell command', value: macro.cmd,
            });
            if (cmd === undefined) break;

            const desc = await vscode.window.showInputBox({
              title: `Edit "${macro.label}" — 3 of 4`, prompt: 'Description', value: macro.desc,
            });
            if (desc === undefined) break;

            // Step 4: group — show quick-pick of existing groups + option to enter new
            const existingGroups = [...new Set(commands.map(c => c.group).filter(Boolean))];
            let group = macro.group;

            if (existingGroups.length) {
              const pick = await vscode.window.showQuickPick(
                ['(no group)', ...existingGroups, '+ New group…'],
                { title: `Edit "${macro.label}" — 4 of 4`, placeHolder: 'Assign to a group' }
              );
              if (pick === undefined) break;
              if (pick === '+ New group…') {
                const ng = await vscode.window.showInputBox({ prompt: 'New group name' });
                group = ng?.trim().toLowerCase() ?? '';
              } else {
                group = pick === '(no group)' ? '' : pick;
              }
            } else {
              const ng = await vscode.window.showInputBox({
                title: `Edit "${macro.label}" — 4 of 4`,
                prompt: 'Group tag (optional)',
                value: macro.group,
                placeHolder: 'e.g. docker, git, npm',
              });
              if (ng === undefined) break;
              group = ng.trim().toLowerCase();
            }

            commands[msg.index] = {
              ...macro,
              label: label.trim() || macro.label,
              cmd:   cmd.trim()   || macro.cmd,
              desc:  desc.trim(),
              group,
            };
            save(); refresh();
            break;
          }

          // ── Pin toggle ────────────────────────────────────────────────────
          case 'pin': {
            commands[msg.index].pinned = !commands[msg.index].pinned;
            save(); refresh();
            break;
          }

          // ── Delete with confirm ───────────────────────────────────────────
          case 'delete': {
            const label = commands[msg.index].label;
            const pick = await vscode.window.showWarningMessage(
              `Remove macro "${label}"?`, { modal: true }, 'Remove'
            );
            if (pick !== 'Remove') break;
            commands.splice(msg.index, 1);
            save(); refresh();
            break;
          }

          // ── Add macro ─────────────────────────────────────────────────────
          case 'openAdd': {
            const label = await vscode.window.showInputBox({
              title: 'New Macro — 1 of 4', prompt: 'Button label', placeHolder: 'e.g. Dev Server',
            });
            if (!label) break;

            const envHint = envVars.length
              ? `Tip: use $${envVars[0].key} as a placeholder`
              : 'Tip: define ENV vars to use as $KEY placeholders';
            const cmd = await vscode.window.showInputBox({
              title: 'New Macro — 2 of 4',
              prompt: `Shell command. ${envHint}`,
              placeHolder: 'e.g. npm run dev -- --port $PORT',
            });
            if (!cmd) break;

            const desc = await vscode.window.showInputBox({
              title: 'New Macro — 3 of 4', prompt: 'Short description', placeHolder: 'e.g. Start Vite dev server',
            });

            const existingGroups = [...new Set(commands.map(c => c.group).filter(Boolean))];
            let group = '';
            if (existingGroups.length) {
              const pick = await vscode.window.showQuickPick(
                ['(no group)', ...existingGroups, '+ New group…'],
                { title: 'New Macro — 4 of 4', placeHolder: 'Assign to a group' }
              );
              if (pick === undefined) break;
              if (pick === '+ New group…') {
                const ng = await vscode.window.showInputBox({ prompt: 'New group name' });
                group = ng?.trim().toLowerCase() ?? '';
              } else if (pick !== '(no group)') {
                group = pick;
              }
            } else {
              const ng = await vscode.window.showInputBox({
                title: 'New Macro — 4 of 4',
                prompt: 'Group tag (optional, leave blank for none)',
                placeHolder: 'e.g. docker, git, npm',
              });
              group = ng?.trim().toLowerCase() ?? '';
            }

            commands.push({
              label:      label.trim(),
              cmd:        cmd.trim(),
              desc:       (desc ?? '').trim(),
              color:      COLORS[commands.length % COLORS.length],
              pinned:     false,
              usageCount: 0,
              group,
            });
            save(); refresh();
            break;
          }

          // ── Env vars ──────────────────────────────────────────────────────
          case 'addEnv': {
            const key = await vscode.window.showInputBox({
              title: 'Add Env Var — 1 of 2',
              prompt: 'Variable name (used as $NAME in commands)',
              placeHolder: 'e.g. PORT',
              validateInput: v => /^[A-Z_][A-Z0-9_]*$/i.test(v.trim())
                ? undefined : 'Letters, numbers, underscores only',
            });
            if (!key) break;

            const value = await vscode.window.showInputBox({
              title: 'Add Env Var — 2 of 2',
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

  // ── Terminal auto-capture ──────────────────────────────────────────────────

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

        const label = await vscode.window.showInputBox({ prompt: 'Button label', value: firstWord });
        if (!label) return;

        const desc = await vscode.window.showInputBox({ prompt: 'Description', placeHolder: 'What does this command do?' });

        const existingGroups = [...new Set(commands.map(c => c.group).filter(Boolean))];
        let group = '';
        if (existingGroups.length) {
          const pick = await vscode.window.showQuickPick(['(no group)', ...existingGroups], { placeHolder: 'Assign to a group' });
          if (pick && pick !== '(no group)') group = pick;
        }

        commands.push({
          label: label.trim(), cmd: rawCmd, desc: (desc ?? '').trim(),
          color: COLORS[commands.length % COLORS.length],
          pinned: false, usageCount: 1, group,
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

  const allGroups = [...new Set(cmds.map(c => c.group).filter(Boolean))];
  const groupColor = (g: string) => COLORS[allGroups.indexOf(g) % COLORS.length];

  // ── Inline SVG icons ──────────────────────────────────────────────────────
  const runSvg      = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.745 3.064a.5.5 0 0 0-.745.435v9.002a.5.5 0 0 0 .745.435l8-4.501a.5.5 0 0 0 0-.87l-8-4.501z"/></svg>`;
  const runArgsSvg  = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3 3.5a.5.5 0 0 1 .745-.435l8 4.5a.5.5 0 0 1 0 .87l-4.5 2.53V13a.5.5 0 0 1-1 0v-2.5H4.5a.5.5 0 0 1 0-1h.745V9.065L3.745 8.5A.5.5 0 0 1 3 8.065V3.5zm9.5 5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1z"/></svg>`;
  const copySvg     = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4.085V11H3V3h6v1H4.085A.085.085 0 0 0 4 4.085zM5 5v8h8V5H5zm7 7H6V6h6v6z"/></svg>`;
  const editSvg     = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="m13.207 2-.707.707 1.586 1.586.707-.707L13.207 2zM11.793 3.5 3.5 11.793V13.5h1.707l8.293-8.293L11.793 3.5zm-9 9 8.5-8.5.707.707-8.5 8.5H2.5v-1.207h.293z"/></svg>`;
  const pinSvg      = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M10.059 2.445c-.689-.715-1.889-.537-2.363.353L5.653 6.589l-2.811.937a.5.5 0 0 0-.242.794l2.146 2.147-2.646 2.646-.147.854.854-.147 2.646-2.646 2.146 2.146a.5.5 0 0 0 .794-.242l.937-2.811 3.791-2.043c.89-.474 1.068-1.655.353-2.363L10.059 2.445zm-1.5 1.13.56.56-3.25 1.753-.368 1.107-1.195-1.195 1.107-.369 1.753-3.25.56.56-.167-.166z"/></svg>`;
  const pinnedSvg   = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M10.059 2.445c-.689-.715-1.889-.537-2.363.353L5.653 6.589l-2.811.937C2.677 7.581 2.553 7.717 2.513 7.885c-.04.168.01.345.133.468l2.146 2.147-2.646 2.646-.147.854.854-.147 2.646-2.646 2.146 2.146a.5.5 0 0 0 .613.073l.158-.09.937-2.812 4.246-2.09c.89-.474 1.068-1.655.353-2.363L10.059 2.445z"/></svg>`;
  const trashSvg    = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5zM5 2.5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5v1h2.5a.5.5 0 0 1 0 1H13v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9H2.5a.5.5 0 0 1 0-1H5zm1 3.5a.5.5 0 0 0-1 0v5a.5.5 0 0 0 1 0V6zm3 0a.5.5 0 0 0-1 0v5a.5.5 0 0 0 1 0V6z"/></svg>`;
  const searchSvg   = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.017.016zm-5.242 1.4a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"/></svg>`;

  // ── Chips ─────────────────────────────────────────────────────────────────
  const chips = sorted.map(c => `
    <div class="chip${c.pinned ? ' pinned' : ''}" data-index="${c.originalIndex}" title="${esc(c.cmd)}">
      <span class="dot" style="background:${c.color}"></span>
      <span class="chip-label">${esc(c.label)}</span>
      ${c.usageCount > 0 ? `<span class="badge">${c.usageCount}</span>` : ''}
    </div>`).join('');

  // ── Group filter pills ────────────────────────────────────────────────────
  const groupPills = allGroups.map(g => `
    <button class="pill" data-group="${esc(g)}" style="--pill-color:${groupColor(g)}">
      <span class="pill-dot" style="background:${groupColor(g)}"></span>${esc(g)}
    </button>`).join('');

  // ── List rows ─────────────────────────────────────────────────────────────
  const rows = sorted.length
    ? sorted.map(c => `
      <div class="row${c.pinned ? ' pinned' : ''}"
        data-group="${esc(c.group)}"
        data-label="${esc(c.label)}"
        data-cmd="${esc(c.cmd)}"
        data-desc="${esc(c.desc)}"
        title="${esc(c.desc || c.cmd)}"
      >
        <span class="row-dot" style="background:${c.color}"></span>
        <span class="row-name">
          <span class="row-name-text">${esc(c.label)}</span>
          ${c.group ? `<span class="group-tag" style="color:${groupColor(c.group)};border-color:${groupColor(c.group)}55">${esc(c.group)}</span>` : ''}
        </span>
        <span class="row-cmd">${esc(c.cmd)}</span>
        <div class="row-actions">
          <button class="row-btn btn-run"  data-index="${c.originalIndex}" title="Run">${runSvg}</button>
          <button class="row-btn btn-args" data-index="${c.originalIndex}" title="Run with args">${runArgsSvg}</button>
          <button class="row-btn btn-copy" data-index="${c.originalIndex}" title="Copy command">${copySvg}</button>
          <button class="row-btn btn-edit" data-index="${c.originalIndex}" title="Edit">${editSvg}</button>
          <button class="row-btn btn-pin${c.pinned ? ' is-pinned' : ''}" data-index="${c.originalIndex}" title="${c.pinned ? 'Unpin' : 'Pin'}">${c.pinned ? pinnedSvg : pinSvg}</button>
          <button class="row-btn btn-del"  data-index="${c.originalIndex}" title="Remove">${trashSvg}</button>
        </div>
      </div>`).join('')
    : `<div class="empty-state">No macros yet — click <strong>+ Add</strong> to create one.</div>`;

  // ── Env rows ──────────────────────────────────────────────────────────────
  const envRows = envVars.length
    ? envVars.map((e, i) => `
      <div class="env-row">
        <span class="env-key">$${esc(e.key)}</span>
        <span class="env-eq">=</span>
        <span class="env-val">${esc(e.value)}</span>
        <button class="env-del" data-index="${i}" title="Remove">✕</button>
      </div>`).join('')
    : `<div class="env-empty">No env vars — add one to use as <code>$KEY</code> in commands.</div>`;

  return /* html */`<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline' vscode-resource:; font-src vscode-resource:; script-src 'unsafe-inline';">
<link rel="stylesheet" href="${codiconsUri}" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

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

  /* ── Chip bar ──────────────────────────────────────── */
  .bar {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 7px;
    height: 28px;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    flex-shrink: 0;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .bar-label {
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    padding-right: 6px;
    border-right: 1px solid var(--vscode-widget-border);
    flex-shrink: 0;
  }
  .chip-scroll {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    flex: 1;
    align-items: center;
    scrollbar-width: none;
  }
  .chip-scroll::-webkit-scrollbar { display: none; }
  .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 10px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-widget-border);
    white-space: nowrap;
    font-size: 10px;
    font-family: monospace;
    flex-shrink: 0;
    color: var(--vscode-foreground);
    transition: background 0.1s, border-color 0.1s;
  }
  .chip:hover  { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
  .chip.pinned { border-color: var(--vscode-focusBorder); }
  .chip.flash  { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .badge {
    font-size: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 8px;
    padding: 0 3px;
    min-width: 12px;
    text-align: center;
  }

  /* ── Toolbar buttons ───────────────────────────────── */
  .bar-btn {
    padding: 1px 7px;
    background: none;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    flex-shrink: 0;
    font-family: var(--vscode-font-family);
    transition: border-color 0.1s, color 0.1s;
  }
  .bar-btn:hover  { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  .bar-btn.active { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
  .add-btn { border-style: dashed; }

  /* ── Filter bar ────────────────────────────────────── */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 7px;
    height: 26px;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    flex-shrink: 0;
  }
  .search-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 3px;
    padding: 1px 5px;
  }
  .search-wrap:focus-within { border-color: var(--vscode-focusBorder); }
  .search-icon { color: var(--vscode-descriptionForeground); flex-shrink: 0; display: flex; align-items: center; }
  .search-input {
    background: none; border: none; outline: none;
    font-family: var(--vscode-font-family); font-size: 10px;
    color: var(--vscode-input-foreground); width: 100%;
  }
  .search-input::placeholder { color: var(--vscode-input-placeholderForeground); }

  .group-pills {
    display: flex;
    gap: 3px;
    overflow-x: auto;
    scrollbar-width: none;
    flex-shrink: 0;
    max-width: 50%;
  }
  .group-pills::-webkit-scrollbar { display: none; }
  .pill {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 8px;
    border: 1px solid var(--vscode-widget-border);
    background: none;
    color: var(--vscode-descriptionForeground);
    font-size: 9px;
    font-family: var(--vscode-font-family);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: all 0.1s;
  }
  .pill:hover { border-color: var(--pill-color); color: var(--pill-color); }
  .pill.active {
    border-color: var(--pill-color);
    color: var(--pill-color);
    background: color-mix(in srgb, var(--pill-color) 12%, transparent);
  }
  .pill-dot { width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0; }

  /* ── Env panel ─────────────────────────────────────── */
  .env-panel {
    display: none;
    flex-direction: column;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    flex-shrink: 0;
    max-height: 120px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .env-panel.open { display: flex; }
  .env-header {
    display: flex;
    align-items: center;
    padding: 3px 8px;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-widget-border);
    position: sticky;
    top: 0;
    background: inherit;
    flex-shrink: 0;
  }
  .env-header-title { flex: 1; }
  .env-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    font-family: monospace;
    font-size: 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 40%, transparent);
    transition: background 0.1s;
  }
  .env-row:last-child { border-bottom: none; }
  .env-row:hover { background: var(--vscode-list-hoverBackground); }
  .env-key { color: #4fc1ff; font-weight: 600; min-width: 70px; }
  .env-eq  { color: var(--vscode-descriptionForeground); }
  .env-val { color: #ce9178; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .env-del {
    background: none; border: none; cursor: pointer;
    color: var(--vscode-errorForeground); font-size: 10px;
    padding: 0 2px; opacity: 0.4; line-height: 1; flex-shrink: 0;
    transition: opacity 0.1s;
  }
  .env-del:hover { opacity: 1; }
  .env-empty {
    padding: 6px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    font-style: italic;
  }
  .env-empty code { font-family: monospace; color: #4fc1ff; font-style: normal; }

  /* ── Command list ──────────────────────────────────── */
  .list {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
  }
  .list::-webkit-scrollbar { width: 3px; }
  .list::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 2px; }

  .list-header {
    display: grid;
    grid-template-columns: 7px 1fr 1.4fr 110px;
    gap: 6px;
    padding: 3px 8px;
    font-size: 8px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .row {
    display: grid;
    grid-template-columns: 7px 1fr 1.4fr 110px;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 40%, transparent);
    min-height: 27px;
    transition: background 0.1s;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.pinned { border-left: 2px solid var(--vscode-focusBorder); padding-left: 6px; }

  .row-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  .row-name {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }
  .row-name-text { overflow: hidden; text-overflow: ellipsis; }
  .group-tag {
    font-size: 8px;
    padding: 0 4px;
    border-radius: 8px;
    border: 1px solid;
    font-weight: 400;
    white-space: nowrap;
    flex-shrink: 0;
    letter-spacing: 0.02em;
    opacity: 0.9;
  }

  .row-cmd {
    font-family: monospace;
    font-size: 10px;
    color: #4fc1ff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Row action buttons ────────────────────────────── */
  .row-actions { display: flex; gap: 2px; align-items: center; }
  .row-btn {
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    color: var(--vscode-foreground);
    opacity: 0.3;
    transition: opacity 0.1s, background 0.1s, border-color 0.1s, color 0.1s;
  }
  .row:hover .row-btn { opacity: 0.6; }
  .row-btn:hover { opacity: 1 !important; border-color: currentColor; }

  .btn-run:hover  { color: #4ec9b0; background: color-mix(in srgb, #4ec9b0 15%, transparent); }
  .btn-args:hover { color: #c586c0; background: color-mix(in srgb, #c586c0 15%, transparent); }
  .btn-copy:hover { color: #9cdcfe; background: color-mix(in srgb, #9cdcfe 15%, transparent); }
  .btn-edit:hover { color: #dcdcaa; background: color-mix(in srgb, #dcdcaa 15%, transparent); }
  .btn-pin:hover  { color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent); }
  .btn-pin.is-pinned { opacity: 0.9 !important; color: var(--vscode-focusBorder); }
  .btn-del:hover  { color: #f44747; background: color-mix(in srgb, #f44747 15%, transparent); }

  /* ── Empty / no-results ────────────────────────────── */
  .empty-state {
    padding: 20px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    text-align: center;
    line-height: 1.7;
  }
  .no-results {
    padding: 12px 8px;
    text-align: center;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    display: none;
  }
</style>
</head>
<body>

<!-- Chip bar -->
<div class="bar">
  <span class="bar-label">MACROS</span>
  <div class="chip-scroll">${chips}</div>
  <button class="bar-btn" id="envBtn">ENV${envVars.length ? ` (${envVars.length})` : ''}</button>
  <button class="bar-btn add-btn" id="addBtn">+ Add</button>
</div>

<!-- Filter bar: search + group pills -->
<div class="filter-bar">
  <div class="search-wrap">
    <span class="search-icon">${searchSvg}</span>
    <input class="search-input" id="searchInput" placeholder="Search macros…" autocomplete="off" spellcheck="false" />
  </div>
  ${allGroups.length ? `
  <div class="group-pills">
    <button class="pill active" data-group="" style="--pill-color: var(--vscode-foreground)">All</button>
    ${groupPills}
  </div>` : ''}
</div>

<!-- Env panel (toggleable) -->
<div class="env-panel" id="envPanel">
  <div class="env-header">
    <span class="env-header-title">Env Vars — use as $KEY in commands</span>
    <button class="bar-btn" id="addEnvBtn" style="border-style:dashed;padding:1px 5px">+ Add</button>
  </div>
  ${envRows}
</div>

<!-- Command list -->
<div class="list">
  <div class="list-header">
    <span></span>
    <span>Name</span>
    <span>Command</span>
    <span>Actions</span>
  </div>
  ${rows}
  <div class="no-results" id="noResults">No macros match your search.</div>
</div>

<script>
  const vsc = acquireVsCodeApi();

  // ── Chips → run ──────────────────────────────────────────────────────────
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.add('flash');
      setTimeout(() => chip.classList.remove('flash'), 200);
      vsc.postMessage({ type: 'run', index: +chip.dataset.index });
    });
  });

  // ── Row buttons ──────────────────────────────────────────────────────────
  document.querySelectorAll('.btn-run') .forEach(b => b.addEventListener('click', e => { e.stopPropagation(); vsc.postMessage({ type: 'run',        index: +b.dataset.index }); }));
  document.querySelectorAll('.btn-args').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); vsc.postMessage({ type: 'runWithArgs', index: +b.dataset.index }); }));
  document.querySelectorAll('.btn-copy').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); vsc.postMessage({ type: 'copyCmd',     index: +b.dataset.index }); }));
  document.querySelectorAll('.btn-edit').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); vsc.postMessage({ type: 'openEdit',    index: +b.dataset.index }); }));
  document.querySelectorAll('.btn-pin') .forEach(b => b.addEventListener('click', e => { e.stopPropagation(); vsc.postMessage({ type: 'pin',         index: +b.dataset.index }); }));
  document.querySelectorAll('.btn-del') .forEach(b => b.addEventListener('click', e => { e.stopPropagation(); vsc.postMessage({ type: 'delete',      index: +b.dataset.index }); }));

  // ── Search + group filter (client-side, instant) ─────────────────────────
  const searchInput = document.getElementById('searchInput');
  const noResults   = document.getElementById('noResults');
  let activeGroup   = '';

  function applyFilter() {
    const q = searchInput.value.toLowerCase().trim();
    let visible = 0;
    document.querySelectorAll('.row').forEach(row => {
      const matchGroup  = !activeGroup || row.dataset.group === activeGroup;
      const matchSearch = !q
        || row.dataset.label.toLowerCase().includes(q)
        || row.dataset.cmd.toLowerCase().includes(q)
        || row.dataset.desc.toLowerCase().includes(q);
      const show = matchGroup && matchSearch;
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    noResults.style.display = (visible === 0 && document.querySelectorAll('.row').length > 0) ? 'block' : 'none';
  }

  searchInput.addEventListener('input', applyFilter);

  document.querySelectorAll('.pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeGroup = pill.dataset.group;
      applyFilter();
    });
  });

  // ── ENV panel ────────────────────────────────────────────────────────────
  const envPanel = document.getElementById('envPanel');
  const envBtn   = document.getElementById('envBtn');
  envBtn.addEventListener('click', () => {
    const open = envPanel.classList.toggle('open');
    envBtn.classList.toggle('active', open);
  });
  document.querySelectorAll('.env-del').forEach(b =>
    b.addEventListener('click', () => vsc.postMessage({ type: 'deleteEnv', index: +b.dataset.index })));
  document.getElementById('addEnvBtn').addEventListener('click', () =>
    vsc.postMessage({ type: 'addEnv' }));

  // ── Add ──────────────────────────────────────────────────────────────────
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