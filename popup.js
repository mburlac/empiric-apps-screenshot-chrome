const btnFull = document.getElementById('captureFull');
const btnRegion = document.getElementById('captureRegion');
const btnElement = document.getElementById('captureElement');
const copyToggle = document.getElementById('copyToggle');
const editToggle = document.getElementById('editToggle');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');

const KEY_CLIPBOARD = 'copyToClipboard';
const KEY_EDIT = 'editBeforeSave';
const KEY_DELAY = 'captureDelay';

let delaySeconds = 0;

chrome.storage.local.get([KEY_CLIPBOARD, KEY_EDIT, KEY_DELAY], (data) => {
  copyToggle.checked = Boolean(data[KEY_CLIPBOARD]);
  editToggle.checked = Boolean(data[KEY_EDIT]);
  delaySeconds = Number(data[KEY_DELAY]) || 0;
  updateDelayUI();
});

renderShortcutHints();

function renderShortcutHints() {
  if (!chrome.commands?.getAll) return;
  chrome.commands.getAll((commands) => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const map = { 'capture-full-page': 'kbdFull', 'capture-region': 'kbdRegion' };
    for (const cmd of commands) {
      const el = document.getElementById(map[cmd.name]);
      if (!el || !cmd.shortcut) continue;
      el.textContent = formatShortcut(cmd.shortcut, isMac);
    }
  });
}

function formatShortcut(s, isMac) {
  if (!isMac) return s;
  return s
    .replace(/Ctrl/g, '⌃')
    .replace(/Alt/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/Command/g, '⌘')
    .replace(/MacCtrl/g, '⌃')
    .replace(/\+/g, '');
}

copyToggle.addEventListener('change', () => {
  chrome.storage.local.set({ [KEY_CLIPBOARD]: copyToggle.checked });
});

editToggle.addEventListener('change', () => {
  chrome.storage.local.set({ [KEY_EDIT]: editToggle.checked });
});

document.querySelectorAll('#delaySegments .seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    delaySeconds = Number(btn.dataset.delay) || 0;
    chrome.storage.local.set({ [KEY_DELAY]: delaySeconds });
    updateDelayUI();
  });
});

function updateDelayUI() {
  document.querySelectorAll('#delaySegments .seg').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.delay) === delaySeconds);
  });
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function setBusy(busy) {
  btnFull.disabled = busy;
  btnRegion.disabled = busy;
  btnElement.disabled = busy;
  progressEl.classList.toggle('active', busy);
  if (!busy) progressFill.style.width = '0%';
}

async function runCapture(action) {
  setBusy(true);
  setStatus('Preparing...');
  progressFill.style.width = '0%';

  try {
    const response = await chrome.runtime.sendMessage({
      action,
      copyToClipboard: copyToggle.checked,
      editBeforeSave: editToggle.checked,
      delaySeconds,
    });

    if (response?.error) {
      setStatus(response.error, 'error');
      setBusy(false);
      return;
    } else if (response?.pending) {
      const hint = action === 'startElementCapture' ? 'Pick an element on the page...' : 'Draw a region on the page...';
      setStatus(delaySeconds > 0 ? `Waiting ${delaySeconds}s...` : hint);
      window.close();
      return;
    } else {
      progressFill.style.width = '100%';
      setStatus(copyToggle.checked ? 'Saved and copied' : 'Saved to Downloads', 'success');
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  }

  setTimeout(() => setBusy(false), 1500);
}

btnFull.addEventListener('click', () => runCapture('captureFullPage'));
btnRegion.addEventListener('click', () => runCapture('startRegionCapture'));
btnElement.addEventListener('click', () => runCapture('startElementCapture'));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'captureProgress') {
    const pct = Math.round((msg.current / msg.total) * 100);
    progressFill.style.width = pct + '%';
    setStatus(`Capturing ${msg.current}/${msg.total}`);
  }
});

// The popup is a focused document with clipboardWrite permission. While it is
// open (notably during full-page capture) the background routes the final image
// here to write it to the clipboard, since the offscreen document and the active
// tab are often not focused at copy time.
const bgPort = chrome.runtime.connect({ name: 'popup' });
bgPort.onMessage.addListener(async (msg) => {
  if (msg.action !== 'clipboardImage') return;
  let ok = false;
  try {
    await writeImageToClipboard(msg.dataUrl);
    ok = true;
  } catch (err) {
    console.error('Popup clipboard write failed:', err);
  }
  try { bgPort.postMessage({ action: 'clipboardResult', ok }); } catch {}
});

async function writeImageToClipboard(dataUrl) {
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
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
}
