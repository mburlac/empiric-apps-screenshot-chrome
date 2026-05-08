# Empiric Studio

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/ojklnfmgbcnhjbjgpbkkomfdpjochlce?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/ojklnfmgbcnhjbjgpbkkomfdpjochlce)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

Premium screenshot tool for Chrome — capture full page or any region, annotate with shapes, text, blur, redact, and copy to clipboard. Runs entirely on-device. No analytics, no accounts, no cloud.

> Part of the [Empiric Apps](https://www.empiricapps.com) family of premium native tools.

---

## Install

- **Chrome Web Store** → [chromewebstore.google.com/detail/ojklnfmgbcnhjbjgpbkkomfdpjochlce](https://chromewebstore.google.com/detail/ojklnfmgbcnhjbjgpbkkomfdpjochlce)
- **Manual** → download the latest `.zip` from [Releases](https://github.com/mburlac/empiric-apps-screenshot-chrome/releases), unzip, then load it via `chrome://extensions` → *Load unpacked*.

## Features

### Capture modes
- **Full page** — stitches the entire scrollable page, including content below the fold (`Alt+Shift+F`)
- **Select area** — drag to pick any region of the visible viewport (`Alt+Shift+R`)
- **Capture element** — hover-pick any scrollable element (sidebar, chat pane, modal) and capture its full content
- **Capture delay** — 3s or 5s delay to catch menus, dropdowns, and hover states

Shortcuts can be rebound at `chrome://extensions/shortcuts`.

### Editor
Every region capture opens in a dedicated annotation editor:

- Rectangle, ellipse, line, arrow — customizable stroke color, width, and fill
- Text labels with Small / Medium / Large sizing
- Auto-numbered badges for step-by-step tutorials
- Highlight — translucent marker overlay that keeps text legible
- Marker — freehand drawing
- Blur — real pixel blur at Light / Medium / Strong intensity
- Redact — one-click solid black bar
- Eyedropper — pick any color directly from the screenshot
- Frame — wrap the screenshot with padding, gradient or solid background, rounded corners, and drop shadow for share-ready visuals

All annotations remain editable: select, move, delete, unlimited undo/redo.

### Save your way
- Download as PNG (region) or JPG (full page) to your Downloads folder
- Copy to clipboard — paste straight into Slack, email, Figma, Google Docs
- Or both at once

### Keyboard shortcuts
`V` select · `R` rectangle · `O` ellipse · `L` line · `A` arrow · `H` highlight · `M` marker · `X` redact · `N` badge · `B` blur · `T` text · `F` frame · `I` eyedropper · `Cmd+Z` / `Cmd+Shift+Z` undo/redo · `Cmd+S` save · `Esc` cancel.

## Privacy

Empiric Studio runs entirely on your device. Screenshots, preferences, and any data never leave your browser. No analytics, no accounts, no cloud. Full privacy policy: [empiricapps.com/privacy-studio](https://www.empiricapps.com/privacy-studio).

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Capture the visible content of the active tab when the user clicks the extension |
| `tabs` | Query the active tab's URL (filename) and window ID |
| `scripting` | Inject the region selector overlay and a page measurement script |
| `offscreen` | Canvas operations (stitching, cropping, clipboard fallback) since MV3 service workers have no DOM |
| `downloads` | Save screenshots to the Downloads folder |
| `storage` | Persist user preferences across sessions |
| `clipboardWrite` | Copy screenshots to the system clipboard when enabled |

No host permissions, no remote code, no `eval`.

## Tech

- Manifest V3
- Service worker background + offscreen document for canvas/clipboard
- Vanilla JS, no build step

## Development

```sh
git clone https://github.com/mburlac/empiric-apps-screenshot-chrome.git
cd empiric-apps-screenshot-chrome
# load in Chrome via chrome://extensions → Developer mode → Load unpacked
```

## Links

- Empiric Apps — [www.empiricapps.com](https://www.empiricapps.com)
- Privacy policy — [empiricapps.com/privacy-studio](https://www.empiricapps.com/privacy-studio)
- Chrome Web Store — [Empiric Studio](https://chromewebstore.google.com/detail/ojklnfmgbcnhjbjgpbkkomfdpjochlce)

## License

[MIT](./LICENSE) © Empiric Apps
