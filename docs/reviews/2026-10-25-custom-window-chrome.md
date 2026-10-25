# Custom window chrome acceptance

Implementation: `684d2ee`, following the approved fully custom titlebar design.

Windows acceptance completed on 2026-10-25. The application now has one approximately36px light titlebar, with custom minimize, maximize/restore and close buttons. Alt does not restore the former native menu row. Closing/reopening preserves the same independent core and chat data. The ordinary browser has no desktop titlebar or content offset.

Root reran four desktop test files:20/20 passed. The implementation's TypeScript, focused lint and production build passed. Independent source review approved the task with no Critical/Important findings; a minor event-driven cleanup test extension remains for the final regression review.

Actual copied Windows application checks covered minimize/restore, maximize/restore, double-click maximize, accessible state labels, Alt, close-to-tray/reopen and authenticated same-core discovery. Packaged smoke covered the local fake provider, CSS/fonts, Electron main exit/browser fallback, authenticated Quit/restart and persisted messages. The user explicitly confirmed mouse titlebar dragging and edge resizing both work. Automated pointer attempts alone were inconclusive and are not counted as those two passing checks.

Root verified five desktop source modules byte-for-byte in both unpacked and copied ASAR archives. Final artifacts under `dist/desktop-artifacts-8c-final/win32-x64`:

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| Nema-0.1.0-win32-x64.zip |353688538|96D95A1783872CFD70D2FDB4998F1961531617058D3079A8599D6A7464D344FF|
| Nema-0.1.0-win32-x64.exe |214693850|CE53DAE5F0FAABFD6C93B76E060A34A197837890580250DD224693145BFBF26A|

Native macOS, first-download/installer prompts and the broader source-publication gates remain separate. This report does not claim the entire desktop plan or full regression suite is complete.

UI inspection reproduced two existing issues for the next bounded repair: over-wide ModelSettings radio inputs and Chinese missing-tool diagnostics appearing in Japanese/English plugin views. Neither is described as fixed by this titlebar change.
