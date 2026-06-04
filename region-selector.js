(() => {
  if (window.__regionSelectorActive) return;
  window.__regionSelectorActive = true;

  const Z = 2147483647;
  const host = document.createElement('div');
  host.setAttribute('data-region-selector', '');
  host.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: ${Z};
    cursor: crosshair;
  `;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .root {
      position: fixed;
      inset: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
      cursor: crosshair;
      user-select: none;
    }
    .mask {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.35);
      transition: background 0.1s ease;
    }
    .selection {
      position: absolute;
      border: 1.5px solid #FFFFFF;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 0 0 9999px rgba(0, 0, 0, 0.45);
      background: transparent;
      pointer-events: none;
      display: none;
    }
    .size-label {
      position: absolute;
      top: 8px;
      left: 8px;
      padding: 3px 7px;
      background: rgba(29, 29, 31, 0.92);
      color: #FFFFFF;
      font-size: 11px;
      font-weight: 500;
      border-radius: 5px;
      letter-spacing: 0.01em;
      white-space: nowrap;
      pointer-events: none;
    }
    .hint {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      padding: 8px 14px;
      background: rgba(29, 29, 31, 0.92);
      color: #FFFFFF;
      font-size: 12px;
      font-weight: 500;
      border-radius: 10px;
      letter-spacing: 0.01em;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hint .kbd {
      display: inline-block;
      padding: 1px 5px;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      font-family: inherit;
      font-size: 10px;
    }
  `;

  const root = document.createElement('div');
  root.className = 'root';

  const mask = document.createElement('div');
  mask.className = 'mask';

  const sel = document.createElement('div');
  sel.className = 'selection';

  const sizeLabel = document.createElement('div');
  sizeLabel.className = 'size-label';
  sel.appendChild(sizeLabel);

  const hint = document.createElement('div');
  hint.className = 'hint';
  const hintText1 = document.createTextNode('Drag to select a region · ');
  const kbd = document.createElement('span');
  kbd.className = 'kbd';
  kbd.textContent = 'Esc';
  const hintText2 = document.createTextNode(' to cancel');
  hint.appendChild(hintText1);
  hint.appendChild(kbd);
  hint.appendChild(hintText2);

  root.appendChild(mask);
  root.appendChild(sel);
  root.appendChild(hint);

  shadow.appendChild(style);
  shadow.appendChild(root);

  document.documentElement.appendChild(host);

  let startX = 0;
  let startY = 0;
  let dragging = false;
  let rect = null;

  const onDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    // Capture the pointer so pointermove/up keep firing on the host even when
    // the cursor passes over cross-origin iframes (otherwise the parent window
    // stops receiving events and the selection freezes mid-drag).
    try { host.setPointerCapture(e.pointerId); } catch {}
    sel.style.display = 'block';
    sel.style.left = startX + 'px';
    sel.style.top = startY + 'px';
    sel.style.width = '0px';
    sel.style.height = '0px';
    mask.style.background = 'transparent';
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    sel.style.left = x + 'px';
    sel.style.top = y + 'px';
    sel.style.width = w + 'px';
    sel.style.height = h + 'px';
    sizeLabel.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    rect = { x, y, w, h };
  };

  const cleanup = () => {
    host.removeEventListener('pointerdown', onDown, true);
    host.removeEventListener('pointermove', onMove, true);
    host.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    window.__regionSelectorActive = false;
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try { host.releasePointerCapture(e.pointerId); } catch {}
    if (!rect || rect.w < 5 || rect.h < 5) {
      chrome.runtime.sendMessage({ action: 'regionCancelled' });
      cleanup();
      return;
    }
    const finalRect = { ...rect, dpr: window.devicePixelRatio || 1 };
    cleanup();
    chrome.runtime.sendMessage({ action: 'regionSelected', rect: finalRect });
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      chrome.runtime.sendMessage({ action: 'regionCancelled' });
      cleanup();
    }
  };

  host.addEventListener('pointerdown', onDown, true);
  host.addEventListener('pointermove', onMove, true);
  host.addEventListener('pointerup', onUp, true);
  window.addEventListener('keydown', onKey, true);
})();
