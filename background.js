let offscreenReady = false;
const pending = new Map();

// The popup is a focused extension page with clipboardWrite permission, so it
// can write images to the clipboard when it is open (e.g. during a full-page
// capture, where the popup stays open). We track its port to route copies there.
let popupPort = null;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPort = port;
  port.onDisconnect.addListener(() => {
    if (popupPort === port) popupPort = null;
  });
});

const KEY_CLIPBOARD = 'copyToClipboard';
const KEY_EDIT = 'editBeforeSave';
const KEY_DELAY = 'captureDelay';

async function ensureOffscreen() {
  if (offscreenReady) return;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING', 'CLIPBOARD'],
      justification: 'Stitch and crop screenshots, copy to clipboard',
    });
  }
  offscreenReady = true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'captureFullPage') {
    (async () => {
      try {
        await runCountdown(msg.delaySeconds);
        await captureFullPage({ copyToClipboard: !!msg.copyToClipboard });
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg.action === 'startRegionCapture') {
    (async () => {
      try {
        await runCountdown(msg.delaySeconds);
        await startRegionCapture({
          copyToClipboard: !!msg.copyToClipboard,
          editBeforeSave: !!msg.editBeforeSave,
        });
        sendResponse({ pending: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg.action === 'startElementCapture') {
    (async () => {
      try {
        await runCountdown(msg.delaySeconds);
        await startElementCapture({
          copyToClipboard: !!msg.copyToClipboard,
          editBeforeSave: !!msg.editBeforeSave,
        });
        sendResponse({ pending: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg.action === 'elementSelected') {
    const tabId = sender.tab?.id;
    const context = pending.get(tabId);
    pending.delete(tabId);
    captureElement({
      tabId,
      windowId: sender.tab?.windowId,
      url: sender.tab?.url,
      isPage: !!msg.isPage,
      context,
    }).catch((err) => { console.error('Element capture failed:', err); showPageError(tabId, err.message); });
    return;
  }

  if (msg.action === 'elementCancelled') {
    pending.delete(sender.tab?.id);
    return;
  }

  if (msg.action === 'editorSave') {
    handleEditorSave(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === 'regionSelected') {
    const tabId = sender.tab?.id;
    const context = pending.get(tabId);
    pending.delete(tabId);
    captureRegion({
      windowId: sender.tab?.windowId,
      url: sender.tab?.url,
      rect: msg.rect,
      context,
    }).catch((err) => { console.error('Region capture failed:', err); showPageError(tabId, err.message); });
    return;
  }

  if (msg.action === 'regionCancelled') {
    pending.delete(sender.tab?.id);
    return;
  }

  if (msg.action === 'stitchComplete') {
    handleComposed(msg);
    return;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const data = await chrome.storage.local.get([KEY_CLIPBOARD, KEY_EDIT, KEY_DELAY]);
    const copyToClipboard = !!data[KEY_CLIPBOARD];
    const editBeforeSave = !!data[KEY_EDIT];
    const delaySeconds = Number(data[KEY_DELAY]) || 0;

    if (command === 'capture-full-page') {
      await runCountdown(delaySeconds);
      await captureFullPage({ copyToClipboard });
    } else if (command === 'capture-region') {
      await runCountdown(delaySeconds);
      await startRegionCapture({ copyToClipboard, editBeforeSave });
    }
  } catch (err) {
    flashErrorBadge();
    console.error('Shortcut command failed:', err);
  }
});

async function flashErrorBadge() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#FF3B30' });
    await chrome.action.setBadgeText({ text: '!' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 2000);
  } catch {}
}

// Element/region failures happen after the popup has closed, so the only
// feedback would be an easy-to-miss badge. Show a toast on the page too.
async function showPageError(tabId, message) {
  flashErrorBadge();
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => {
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1D1D1F;color:#fff;padding:12px 18px;border-radius:10px;font:500 13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:80vw;pointer-events:none;';
        document.documentElement.appendChild(el);
        setTimeout(() => el.remove(), 4000);
      },
      args: [message],
    });
  } catch {}
}

// chrome.runtime.sendMessage rejects payloads over 64MiB. A safety margin keeps
// us clear of that while accounting for the rest of the message envelope.
const MAX_MESSAGE_BYTES = 56 * 1024 * 1024;

function capturesByteEstimate(captures) {
  let total = 0;
  for (const c of captures) total += c.dataUrl ? c.dataUrl.length : 0;
  return total;
}

function assertCaptureNotTooLarge(captures) {
  if (capturesByteEstimate(captures) > MAX_MESSAGE_BYTES) {
    throw new Error('Image too large to process (over Chrome\'s 64MB limit). Try capturing a smaller region.');
  }
}

// Chrome canvases cap at 65535px per side and ~268M px total area. Past that,
// toDataURL silently returns an empty/blank image, so reject up front.
const MAX_CANVAS_SIDE = 65535;
const MAX_CANVAS_AREA = 268000000;

function assertCanvasSizeOk(width, height) {
  const w = Math.round(width);
  const h = Math.round(height);
  if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE || w * h > MAX_CANVAS_AREA) {
    throw new Error('Page is too large to capture as one image. Try capturing a smaller region.');
  }
}

function assertCapturable(tab) {
  if (!tab?.id) throw new Error('No active tab');
  const url = tab.url || '';
  const blocked = /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url)
    || url.startsWith('https://chrome.google.com/webstore')
    || url.startsWith('https://chromewebstore.google.com');
  if (blocked) {
    throw new Error('This page is protected by the browser. Open a regular website and try again.');
  }
}

async function captureFullPage({ copyToClipboard }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  assertCapturable(tab);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
  });

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.__fullPageCapture.measure(),
  });

  const { scrollHeight, viewportHeight, viewportWidth, devicePixelRatio } = result.result;
  const maxScroll = scrollHeight - viewportHeight;
  const totalSteps = Math.ceil(scrollHeight / viewportHeight);
  const captures = [];

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.scrollTo(0, 0),
  });
  await delay(250);

  for (let i = 0; i < totalSteps; i++) {
    const isLast = i === totalSteps - 1;

    if (i === 1) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__fullPageCapture.hideFixed(),
      });
      await delay(100);
    }

    const targetScroll = isLast ? maxScroll : i * viewportHeight;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (y) => window.scrollTo(0, y),
      args: [targetScroll],
    });

    await delay(400);

    const [scrollResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.scrollY,
    });
    const actualScroll = scrollResult.result;

    const dataUrl = await captureWithRetry(tab.windowId, 3);

    captures.push({
      dataUrl,
      scrollY: actualScroll,
      viewportHeight,
    });

    chrome.runtime.sendMessage({
      action: 'captureProgress',
      current: i + 1,
      total: totalSteps,
    }).catch(() => {});
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.__fullPageCapture.restoreFixed(),
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.scrollTo(0, 0),
  });

  const hostname = extractHostname(tab.url);

  assertCanvasSizeOk(viewportWidth, scrollHeight);
  assertCaptureNotTooLarge(captures);

  await ensureOffscreen();
  chrome.runtime.sendMessage({
    action: 'stitch',
    captures,
    hostname,
    totalHeight: scrollHeight,
    viewportWidth,
    viewportHeight,
    devicePixelRatio,
    copyToClipboard,
    mode: 'fullPage',
  });
}

async function startRegionCapture({ copyToClipboard, editBeforeSave }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  assertCapturable(tab);

  pending.set(tab.id, { copyToClipboard, editBeforeSave });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['region-selector.js'],
  });
}

async function startElementCapture({ copyToClipboard, editBeforeSave }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  assertCapturable(tab);

  pending.set(tab.id, { copyToClipboard, editBeforeSave });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['element-picker.js'],
  });
}

async function captureElement({ tabId, windowId, url, isPage, context }) {
  if (!context) return;

  if (isPage) {
    await captureFullPage({ copyToClipboard: context.copyToClipboard });
    return;
  }

  const [measResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.querySelector('[data-empiric-target]');
      if (!el) return null;
      el.scrollTop = 0;
      const r = el.getBoundingClientRect();
      return {
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        dpr: window.devicePixelRatio || 1,
      };
    },
  });
  const m = measResult?.result;
  if (!m) {
    console.error('Lost element reference');
    return;
  }
  if (m.rect.h < 50 || m.rect.w < 50) {
    flashErrorBadge();
    await clearElementMarker(tabId);
    return;
  }

  const totalSteps = Math.max(1, Math.ceil(m.scrollHeight / m.clientHeight));
  const totalScroll = Math.max(0, m.scrollHeight - m.clientHeight);
  const captures = [];

  await delay(200);

  for (let i = 0; i < totalSteps; i++) {
    const isLast = i === totalSteps - 1;
    const targetScroll = isLast ? totalScroll : i * m.clientHeight;

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (st) => {
        const el = document.querySelector('[data-empiric-target]');
        if (!el) return;
        el.scrollTop = st;
      },
      args: [targetScroll],
    });
    await delay(350);

    const [snap] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.querySelector('[data-empiric-target]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, scrollTop: el.scrollTop };
      },
    });
    const meas = snap?.result;
    if (!meas) break;

    const dataUrl = await captureWithRetry(windowId, 3);
    captures.push({ dataUrl, scrollTop: meas.scrollTop, rect: meas });

    chrome.runtime.sendMessage({
      action: 'captureProgress',
      current: i + 1,
      total: totalSteps,
    }).catch(() => {});
  }

  await clearElementMarker(tabId);

  assertCanvasSizeOk(m.rect.w * m.dpr, m.scrollHeight * m.dpr);
  assertCaptureNotTooLarge(captures);

  await ensureOffscreen();
  chrome.runtime.sendMessage({
    action: 'stitchElement',
    captures,
    scrollHeight: m.scrollHeight,
    cssWidth: m.rect.w,
    dpr: m.dpr,
    hostname: extractHostname(url),
    copyToClipboard: context.copyToClipboard,
    editBeforeSave: context.editBeforeSave,
    mode: 'element',
  });
}

async function clearElementMarker(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        document.querySelector('[data-empiric-target]')?.removeAttribute('data-empiric-target');
      },
    });
  } catch {}
}

async function captureRegion({ windowId, url, rect, context }) {
  if (!context) return;
  await delay(150);
  const dataUrl = await captureWithRetry(windowId, 3);
  const hostname = extractHostname(url);

  await ensureOffscreen();
  chrome.runtime.sendMessage({
    action: 'crop',
    dataUrl,
    rect,
    hostname,
    copyToClipboard: context.copyToClipboard,
    editBeforeSave: context.editBeforeSave,
    mode: 'region',
  });
}

async function handleComposed({ dataUrl, hostname, copyToClipboard, editBeforeSave, mode, width, height, cssWidth, cssHeight, dpr }) {
  if (editBeforeSave && (mode === 'region' || mode === 'element')) {
    await openEditor({ dataUrl, hostname, copyToClipboard, width, height, cssWidth, cssHeight, dpr, mode });
    return;
  }
  downloadScreenshot(dataUrl, hostname, mode);
  if (copyToClipboard) {
    await copyImage(dataUrl);
  }
}

// navigator.clipboard.write requires a focused document. Try the popup first
// (focused while open, e.g. during full-page capture); otherwise fall back to
// the active tab (focused for region/element after the user interacted with the
// page, and for keyboard-shortcut captures where no popup steals focus).
async function copyImage(dataUrl) {
  if (popupPort) {
    try {
      const ok = await copyViaPopupPort(dataUrl);
      if (ok) {
        return;
      }
    } catch (e) {
      // Popup unavailable or failed; fall back to the active tab.
    }
  }
  await copyViaActiveTab(dataUrl);
}

function copyViaPopupPort(dataUrl) {
  return new Promise((resolve, reject) => {
    const port = popupPort;
    if (!port) return reject(new Error('no popup port'));
    const onMsg = (m) => {
      if (m?.action !== 'clipboardResult') return;
      cleanup();
      resolve(m.ok);
    };
    const onDisc = () => { cleanup(); reject(new Error('popup disconnected')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('popup timeout')); }, 4000);
    function cleanup() {
      clearTimeout(timer);
      try { port.onMessage.removeListener(onMsg); } catch {}
      try { port.onDisconnect.removeListener(onDisc); } catch {}
    }
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(onDisc);
    port.postMessage({ action: 'clipboardImage', dataUrl });
  });
}

// Fallback: write from the active tab's page context (a focusable document).
// Focusing the tab's window first also dismisses any lingering action popup.
async function copyViaActiveTab(dataUrl) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab for clipboard');

  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
  await delay(60);

  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: writeImageToClipboardInPage,
      args: [dataUrl],
    });
  } catch (err) {
    console.error('[clipboard] injection failed:', err);
    throw new Error('Clipboard: ' + err.message);
  }

  const result = injection?.result;
  if (!result?.ok) {
    throw new Error('Clipboard: ' + (result?.error || 'unknown error'));
  }
}

// Runs in the page (active tab). Converts to PNG if needed, then writes.
async function writeImageToClipboardInPage(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    let pngBlob = blob;
    if (blob.type !== 'image/png') {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }
    if (!document.hasFocus()) window.focus();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function openEditor({ dataUrl, hostname, copyToClipboard, width, height, cssWidth, cssHeight, dpr, mode }) {
  await chrome.storage.session.set({
    'editor.image': { dataUrl, hostname, copyToClipboard, width, height, cssWidth, cssHeight, dpr, mode },
  });

  const toolbarH = 56;
  const chromeH = 40;
  const pad = 40;

  const current = await chrome.windows.getCurrent();
  const maxW = Math.max(800, Math.floor((current.width || 1440) * 0.95));
  const maxH = Math.max(600, Math.floor((current.height || 900) * 0.95));

  const displayW = cssWidth || width || 800;
  const displayH = cssHeight || height || 500;

  const winW = Math.min(maxW, Math.max(720, displayW + pad));
  const winH = Math.min(maxH, Math.max(480, displayH + toolbarH + chromeH + pad));

  await chrome.windows.create({
    url: chrome.runtime.getURL('editor.html'),
    type: 'popup',
    width: winW,
    height: winH,
  });
}

async function handleEditorSave({ dataUrl, hostname, copyToClipboard, mode }) {
  downloadScreenshot(dataUrl, hostname, mode || 'region');
  if (copyToClipboard) {
    await copyImage(dataUrl);
  }
}

function downloadScreenshot(dataUrl, hostname = 'page', mode = 'fullPage') {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '.');
  const suffix = mode === 'region' ? '_region' : (mode === 'element' ? '_element' : '');
  const ext = (mode === 'region' || mode === 'element') ? 'png' : 'jpg';
  chrome.downloads.download({
    url: dataUrl,
    filename: `Screenshot${suffix}_${hostname}_${date}_${time}.${ext}`,
    saveAs: false,
  });
}

function extractHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'page';
  }
}

async function captureWithRetry(windowId, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      if (attempt === retries) throw err;
      await delay(600 * (attempt + 1));
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCountdown(seconds) {
  const s = Math.max(0, Math.min(10, Number(seconds) || 0));
  if (s === 0) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#1D4ED8' });
  } catch {}
  for (let i = s; i > 0; i--) {
    try {
      await chrome.action.setBadgeText({ text: String(i) });
    } catch {}
    await delay(1000);
  }
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch {}
}
