# Custom desktop window chrome

Date: 2026-10-25. Status: approved by the user with “按此设计实现” after explicitly selecting a fully custom title bar and window controls.

The user wants the desktop window to match Nema's application UI. The current native title bar and the separate in-window Nema menu row are replaced with one approximately 36px light title bar using the existing monochrome palette. The left side identifies Nema; the right side has custom minimize, maximize/restore and close controls, with accessible labels, focus and hover states. Empty title-bar space supports dragging; normal window resize and double-click maximize/restore remain available.

Closing this window keeps the Electron tray and independent core running. Explicit Quit Nema remains available from the tray and performs authenticated drain. Renderer or Electron main failure keeps the independent core semantics already approved. The ordinary browser UI does not show desktop window chrome.

Approaches considered: a custom title area with native overlay buttons, or fully custom title area and buttons. The controller recommended the native-button approach for lower compatibility cost. The user explicitly chose fully custom controls; that choice governs this change.

Implementation call: retain renderer sandbox, context isolation and disabled Node integration. If a preload bridge is needed, it exposes only fixed window actions and sanitized window-state events; the main process validates the owning window/frame/origin. It exposes no credentials, filesystem operations, arbitrary IPC channel names or process execution. Existing UI styling and desktop detection should be reused; no search, account, update or other toolbar features are introduced.

Validate actual Windows minimize/restore/maximize/drag/resize/close-to-tray and reopen against the packaged application, including normal browser mode and persistence. macOS source/configuration follows the existing supported-platform plan; native macOS verification remains an explicit external gate. Preserve the functional desktop baseline and review this visual/security addition separately.
