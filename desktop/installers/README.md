# Windows installer templates

Windows builds and releases use only the NSIS EXE installer, selected by
`desktop/src-tauri/tauri.windows.conf.json`. The WiX template is retained as
historical reference and is not part of the default build or update manifest.

These templates are copied from the `tauri-cli-v2.12.2` tag, matching the CLI
version pinned in `desktop/package.json`. Keep their installer, updater, WebView2,
registry and uninstall behavior in sync when upgrading the CLI.

- [NSIS source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
  (original SHA-256 `166f9677d42e81c7f712a1bf80d9d8c089c21d2967d8398474768b5eac14b494`).
- [WiX source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle/windows/msi/main.wxs)
  (original SHA-256 `e371a01628a06730828f9bd24111feacb8bec53c250ccec4b46df756fe0a0198`).

Local changes only customize the first-install default:

- Use `D:\project files\Serial Debug` when the D drive is available.
- Keep the normal directory chooser and explicit command-line install directory.
- Restore the registered install directory before an upgrade. NSIS uses its
  existing default registry value; MSI also recognizes the `InstallDir` value.
- Without D, NSIS falls back to the current user's LocalAppData directory; MSI
  keeps the upstream Program Files fallback and requires machine installation.
- Making MSI `INSTALLDIR` secure carries a user-selected path into the elevated
  Windows Installer session.
- MSI searches history into the separate secure `PREVIOUS_INSTALLDIR` property,
  then restores it only if `INSTALLDIR` is empty. The D-drive default follows
  that restore in both UI and execute sequences, protecting explicit `INSTALLDIR`.

Run `node --test desktop/scripts/installer-templates.test.mjs` for structural
checks. They do not replace Windows installer execution. Before publishing a
Windows release, verify fresh installs with/without D, directory browsing and
explicit `/D=` (NSIS) / `INSTALLDIR=` (MSI), upgrade from a custom directory,
uninstall, and the app updater's NSIS install path. Test an unwritable D target
and choose another location when prompted by the installer's directory checks.

The upstream source is used under the included MIT license.
