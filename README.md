# Lazy Terminal

Stop retyping your most-used terminal commands. Save them as one-click macros, wire up env vars, and run commands with custom args — all from a compact panel in VS Code.

---

![screenshot](./Capture.png)


## Features

### ▶ One-Click Macros
Save any shell command as a labeled button. Click to run it in the active terminal instantly.

### ▶+ Run with Args
Need to pass extra flags without saving a separate macro? Hit the **▶+** button to append args on the fly before running.

```
Base command:  npm run dev
Extra args:    --port $PORT --open
Final command: npm run dev --port 3000 --open
```

### ENV Vars
Define key-value pairs and reference them in any command using `$KEY` or `${KEY}` syntax. Supports recursive variables — vars that reference other vars.

```
PORT = 3000
HOST = localhost
URL  = $HOST:$PORT        →  resolves to: localhost:3000
CMD  = curl $URL/health   →  resolves to: curl localhost:3000/health
```

### 📌 Pin & Sort
Pin your most critical macros to keep them at the top. Commands auto-sort by usage count so your most-run commands are always first.

### 🔁 Auto-Capture
Run any command in your terminal and Lazy Terminal will ask if you want to save it as a macro — no manual setup needed.

---

## Usage

The **Lazy Terminal** panel appears in the bottom panel area (next to Terminal, Output, etc.).

| Button | Action |
|--------|--------|
| **▶** | Run the command |
| **▶+** | Run with extra args |
| **↑ / ↓** | Pin / Unpin |
| **✕** | Remove macro |
| **ENV** | Toggle env vars panel |
| **+ Add** | Add a new macro manually |

---

## Requirements

- VS Code `^1.84.0`
- Shell integration enabled (default in VS Code) for auto-capture feature

---

## Extension Settings

No settings required. All macros and env vars are stored in VS Code's global state and persist across sessions.

---

## Release Notes

### 0.0.4
Initial release — macros, env vars with recursive resolution, run-with-args, pin, auto-capture.