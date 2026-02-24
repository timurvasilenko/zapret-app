# ZPRT App

Tauri + React wrapper around `zapret-discord-youtube` with no modifications to zapret files (except editable `lists/*`).

## Implemented

- Latest release check/install from GitHub (`zapret-discord-youtube-*.zip`)
- Installed version switcher (`zapret/<version>`)
- Dynamic strategy discovery from `general*.bat`
- Start/stop bypass (runs selected strategy)
- Attempted auto-hide of `winws.exe` console windows
- Windows autostart toggle via `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`
- Built-in editors for:
  - `lists/list-general.txt`
  - `lists/list-exclude.txt`
- Tray icon with menu actions: open/start/stop/quit
- Close-to-tray behavior

## Project Structure

- `src/` - React UI
- `src-tauri/src/lib.rs` - app backend logic and Tauri commands
- `zapret/` - installed tool versions (`zapret/<version>`)
- `zprt-app-config.json` - local app config next to app executable (or project root in debug)

## Run

```bash
npm install
npm run tauri dev
```

## Notes

- This repository currently has no Rust toolchain in the environment where code was generated, so `cargo check` was not executed here.
- Frontend build was validated with `npm run build`.
