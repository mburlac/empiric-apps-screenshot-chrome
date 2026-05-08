(() => {
  if (window.__elementPickerActive) return;
  window.__elementPickerActive = true;

  const Z = 2147483647;
  const host = document.createElement('div');
  host.setAttribute('data-element-picker', '');
  host.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: ${Z};
    pointer-events: none;
  `;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .root {
      position: fixed;
      inset: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
      pointer-events: none;
    }
    .highlight {
      position: fixed;
      border: 2px solid #1D4ED8;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.6), 0 0 0 9999px rgba(0, 0, 0, 0.35);
      background: rgba(29, 78, 216, 0.08);
      pointer-events: none;
      transition: top 0.05s ease, left 0.05s ease, width 0.05s ease, height 0.05s ease;
      display: none;
    }
    .label {
      position: absolute;
      bottom: -28px;
      left: 0;
      padding: 3px 8px;
      background: #1D4ED8;
      color: #FFFFFF;
      font-size: 11px;
      font-weight: 500;
      border-radius: 5px;
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
    .hint.no-target {
      background: rgba(255, 59, 48, 0.92);
    }
  `;

  const root = document.createElement('div');
  root.className = 'root';

  const highlight = document.createElement('div');
  highlight.className = 'highlight';
  const label = document.createElement('div');
  label.className = 'label';
  highlight.appendChild(label);

  const hint = document.createElement('div');
  hint.className = 'hint';
  const hintText1 = document.createTextNode('Hover a scrollable area · click to capture · ');
  const kbd = document.createElement('span');
  kbd.className = 'kbd';
  kbd.textContent = 'Esc';
  const hintText2 = document.createTextNode(' to cancel');
  hint.appendChild(hintText1);
  hint.appendChild(kbd);
  hint.appendChild(hintText2);

  root.appendChild(highlight);
  root.appendChild(hint);

  shadow.appendChild(style);
  shadow.appendChild(root);

  document.documentElement.appendChild(host);

  let currentTarget = null;

  function findScrollable(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.nodeType === 1) {
        const cs = getComputedStyle(node);
        const oy = cs.overflowY;
        const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay');
        if (scrollable && node.scrollHeight > node.clientHeight + 2 && node.clientHeight > 50) {
          return node;
        }
      }
      node = node.parentNode;
    }
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 2) return root;
    return null;
  }

  function describe(el) {
    if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
      return `page · ${Math.round(el.scrollHeight)}px`;
    }
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
    return `${tag}${id}${cls} · ${Math.round(el.scrollHeight)}px`;
  }

  function showHighlight(el) {
    if (!el) {
      highlight.style.display = 'none';
      hint.classList.add('no-target');
      hint.firstChild.nodeValue = 'No scrollable area here · ';
      return;
    }
    hint.classList.remove('no-target');
    hint.firstChild.nodeValue = 'Hover a scrollable area · click to capture · ';

    let r;
    if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
      r = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    } else {
      const b = el.getBoundingClientRect();
      r = { left: b.left, top: b.top, width: b.width, height: b.height };
    }
    highlight.style.display = 'block';
    highlight.style.left = r.left + 'px';
    highlight.style.top = r.top + 'px';
    highlight.style.width = r.width + 'px';
    highlight.style.height = r.height + 'px';
    label.textContent = describe(el);
  }

  function elementUnderCursor(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (host.contains(el) || (el.getRootNode && el.getRootNode() === shadow)) continue;
      return el;
    }
    return null;
  }

  const onMove = (e) => {
    const el = elementUnderCursor(e.clientX, e.clientY);
    const scrollable = el ? findScrollable(el) : null;
    currentTarget = scrollable;
    showHighlight(scrollable);
  };

  const cleanup = () => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    window.__elementPickerActive = false;
  };

  const onClick = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!currentTarget) return;

    const el = currentTarget;
    el.setAttribute('data-empiric-target', '');

    const isPage = (el === document.scrollingElement || el === document.documentElement || el === document.body);

    cleanup();
    chrome.runtime.sendMessage({
      action: 'elementSelected',
      isPage,
    });
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ action: 'elementCancelled' });
      cleanup();
    }
  };

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
})();
