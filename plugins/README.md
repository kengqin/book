# Novel Library IDE Integrations

All integrations use the desktop bridge described in `packages/reader-protocol`.
They never open the SQLite file directly. The desktop application writes a per-process
token and port to `%APPDATA%/NovelLibrary/bridge.json`.

## Packages

- `vscode`: VS Code and Cursor extension with a hierarchical bookshelf/chapter/content TreeView, title-bar reader controls, persistent show/hide state, and switchable paragraph/line-end editor decorations.
- `intellij`: one IntelliJ Platform plugin for IDEA, PyCharm, WebStorm, Android Studio,
  Rider, CLion, GoLand and RubyMine, with persistent show/hide state, reconnect handling, and switchable paragraph/line-end editor inlays.
- `visual-studio`: Visual Studio 2022 VSIX project with persistent show/hide state, switchable paragraph/line-end adornments and a bridge client.

The desktop installer includes `scripts/install-ide-plugins.ps1` for the one-click
installation flow. IDEs may still show their own security or permission confirmation.
