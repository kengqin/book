# Novel Library IDE Integrations

All integrations use the desktop bridge described in `packages/reader-protocol`.
They never open the SQLite file directly. The desktop application writes a per-process
The desktop application writes the token and port to `bridge.json` beside its
running executable. Each integration resolves the running NovelLibrary process
and reads that installation-local file; `%APPDATA%/NovelLibrary/bridge.json`
is retained only as a fallback for pre-migration desktop versions.

## Packages

- `vscode`: VS Code and Cursor extension with a hierarchical bookshelf/chapter/content TreeView, a dedicated hover-wheel reading Webview, title-bar reader controls, persistent progress/show-hide state, and switchable paragraph/line-end editor decorations.
- `intellij`: one IntelliJ Platform plugin for IDEA, PyCharm, WebStorm, Android Studio,
  Rider, CLion, GoLand and RubyMine, with persistent show/hide state, reconnect handling, and switchable paragraph/line-end editor inlays.
- `visual-studio`: Visual Studio 2022 VSIX project with persistent show/hide state, switchable paragraph/line-end adornments and a bridge client.

The desktop installer includes `scripts/install-ide-plugins.ps1` for the one-click
installation flow. IDEs may still show their own security or permission confirmation.

In every supported IDE, press `Ctrl+Alt+N` to turn code-inline reading on or off.
In VS Code/Cursor, JetBrains IDEs and Visual Studio, hovering over the five-line reading area and
scrolling the mouse wheel moves to the previous or next novel line.
Each IDE plugin also provides a `快捷键` button in its reader UI that shows every
keyboard shortcut supported by that plugin. These are defaults only: users can
override them through VS Code/Cursor Keyboard Shortcuts, JetBrains Keymap, or
Visual Studio Environment/Keyboard settings.
