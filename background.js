let offscreenReady = false;
const pending = new Map();

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
  if (editBeforeSave && mode === 'region') {
    await openEditor({ dataUrl, hostname, copyToClipboard, width, height, cssWidth, cssHeight, dpr });
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

async function openEditor({ dataUrl, hostname, copyToClipboard, width, height, cssWidth, cssHeight, dpr }) {
  await chrome.storage.session.set({
    'editor.image': { dataUrl, hostname, copyToClipboard, width, height, cssWidth, cssHeight, dpr },
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

async function handleEditorSave({ dataUrl, hostname, copyToClipboard }) {
  downloadScreenshot(dataUrl, hostname, 'region');
  if (copyToClipboard) {
    await copyViaOffscreen(dataUrl);
  }
}

function downloadScreenshot(dataUrl, hostname = 'page', mode = 'fullPage') {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '.');
  const suffix = mode === 'region' ? '_region' : '';
  const ext = mode === 'region' ? 'png' : 'jpg';
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
