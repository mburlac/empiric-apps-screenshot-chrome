let offscreenReady = false;
const pending = new Map();

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
    }).catch((err) => console.error('Element capture failed:', err));
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
    }).catch((err) => console.error('Region capture failed:', err));
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
    await copyViaOffscreen(dataUrl);
  }
}

async function copyViaOffscreen(dataUrl) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({
    action: 'copyToClipboard',
    dataUrl,
  });
  if (result?.error) {
    console.error('Clipboard write failed:', result.error);
    throw new Error('Clipboard: ' + result.error);
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
    await copyViaOffscreen(dataUrl);
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
