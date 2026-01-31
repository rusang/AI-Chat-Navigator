# AI Chat Navigator (Claude fix v4)

This build fixes **Claude.ai** not showing the sidebar due to strict CSP blocking inline `<style>` injection.

Changes (minimal):
- Move the embedded CSS into `styles.css` and inject it via `manifest.json` `content_scripts.css` (CSP-safe).
- Strengthen Claude selectors (`data-testid` fallbacks) for prompt blocks / input / send button.
- In extension environment, skip `injectStyles(styles)` (avoid CSP warnings and duplication).

Install:
1) chrome://extensions -> Developer mode
2) Remove previous build
3) Load unpacked -> select this folder
4) Refresh claude.ai with Cmd/Ctrl+Shift+R
