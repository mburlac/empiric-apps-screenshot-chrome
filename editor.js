(() => {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const canvasWrap = document.getElementById('canvasWrap');

  const state = {
    baseImage: null,
    blurredCanvases: {},
    hostname: 'page',
    copyToClipboard: false,
    dpr: 1,
    shapes: [],
    tool: 'rect',
    color: '#FF3B30',
    fillColor: null,
    strokeWidth: 4,
    blurRadius: 12,
    fontSize: 24,
    previousTool: 'rect',
    textEditing: null,
    selectedId: null,
    history: [],
    historyIndex: -1,
    draft: null,
    dragging: null,
  };

  const FILLABLE_TOOLS = new Set(['rect', 'ellipse']);
  const HIGHLIGHT_ALPHA = 0.4;
  const BADGE_RADIUS = 16;
  const BLUR_RADII = [6, 12, 18];
  const FONT_SIZES = [16, 24, 36];
  const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

  const HIT_THRESHOLD = 6;

  /* =======================================================================
   * Bootstrap
   * ======================================================================= */

  async function boot() {
    const data = await chrome.storage.session.get('editor.image');
    const payload = data['editor.image'];
    if (!payload) {
      document.body.textContent = 'No image to edit.';
      return;
    }
    state.hostname = payload.hostname || 'page';
    state.copyToClipboard = !!payload.copyToClipboard;
    state.dpr = payload.dpr || 1;

    const img = await loadImage(payload.dataUrl);
    state.baseImage = img;
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.style.width = (payload.cssWidth || img.width / state.dpr) + 'px';
    canvas.style.height = (payload.cssHeight || img.height / state.dpr) + 'px';
    prepareBlurCanvases(img);
    pushHistory();
    render();
    bindUI();
    setTool('rect');
    setColor('#FF3B30');
    setStroke(4);
    setFillColor(null);
    setBlurRadius(12);
    setFontSize(24);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function prepareBlurCanvases(img) {
    for (const r of BLUR_RADII) {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const cctx = c.getContext('2d');
      cctx.filter = `blur(${r * state.dpr}px)`;
      cctx.drawImage(img, 0, 0);
      state.blurredCanvases[r] = c;
    }
  }

  /* =======================================================================
   * Rendering
   * ======================================================================= */

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.baseImage) ctx.drawImage(state.baseImage, 0, 0);

    for (const shape of state.shapes) {
      drawShape(ctx, shape, shape.id === state.selectedId);
    }

    if (state.draft) {
      drawShape(ctx, state.draft, false);
    }
  }

  function drawShape(ctx, s, selected) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.strokeWidth * state.dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const minX = Math.min(s.x1, s.x2);
    const minY = Math.min(s.y1, s.y2);
    const w = Math.abs(s.x2 - s.x1);
    const h = Math.abs(s.y2 - s.y1);

    if (s.type === 'rect') {
      if (s.fillColor) {
        ctx.fillStyle = s.fillColor;
        ctx.fillRect(minX, minY, w, h);
        ctx.fillStyle = s.color;
      }
      ctx.strokeRect(minX, minY, w, h);
    } else if (s.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(minX + w / 2, minY + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      if (s.fillColor) {
        ctx.fillStyle = s.fillColor;
        ctx.fill();
        ctx.fillStyle = s.color;
      }
      ctx.stroke();
    } else if (s.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    } else if (s.type === 'arrow') {
      drawArrow(ctx, s);
    } else if (s.type === 'highlight') {
      drawHighlight(ctx, s);
    } else if (s.type === 'marker') {
      drawMarker(ctx, s);
    } else if (s.type === 'redact') {
      const minX2 = Math.min(s.x1, s.x2);
      const minY2 = Math.min(s.y1, s.y2);
      const w2 = Math.abs(s.x2 - s.x1);
      const h2 = Math.abs(s.y2 - s.y1);
      ctx.fillStyle = '#000000';
      ctx.fillRect(minX2, minY2, w2, h2);
    } else if (s.type === 'badge') {
      drawBadge(ctx, s);
    } else if (s.type === 'blur') {
      drawBlur(ctx, s);
    } else if (s.type === 'text') {
      drawText(ctx, s);
    }

    ctx.restore();

    if (selected) drawSelection(ctx, s);
  }

  function drawHighlight(ctx, s) {
    const minX = Math.min(s.x1, s.x2);
    const minY = Math.min(s.y1, s.y2);
    const w = Math.abs(s.x2 - s.x1);
    const h = Math.abs(s.y2 - s.y1);
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = HIGHLIGHT_ALPHA;
    ctx.fillStyle = s.color;
    ctx.fillRect(minX, minY, w, h);
  }

  function drawMarker(ctx, s) {
    if (!s.points || s.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(s.points[0][0], s.points[0][1]);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i][0], s.points[i][1]);
    }
    ctx.stroke();
  }

  function drawBlur(ctx, s) {
    const minX = Math.min(s.x1, s.x2);
    const minY = Math.min(s.y1, s.y2);
    const w = Math.abs(s.x2 - s.x1);
    const h = Math.abs(s.y2 - s.y1);
    const source = state.blurredCanvases[s.blurRadius] || state.blurredCanvases[12];
    if (!source) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(minX, minY, w, h);
    ctx.clip();
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }

  function drawText(ctx, s) {
    if (!s.text) return;
    const fontPx = s.fontSize * state.dpr;
    ctx.font = `500 ${fontPx}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = s.color;
    const lines = s.text.split('\n');
    const lineHeight = fontPx * 1.2;
    let maxW = 0;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], s.x1, s.y1 + i * lineHeight);
      const w = ctx.measureText(lines[i]).width;
      if (w > maxW) maxW = w;
    }
    s.x2 = s.x1 + maxW;
    s.y2 = s.y1 + lines.length * lineHeight;
  }

  function drawBadge(ctx, s) {
    const r = BADGE_RADIUS * state.dpr;
    ctx.beginPath();
    ctx.arc(s.x1, s.y1, r, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.lineWidth = 2 * state.dpr;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `700 ${r * 1.1}px -apple-system, "SF Pro Display", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(s.number), s.x1, s.y1 + r * 0.08);
  }

  function drawArrow(ctx, s) {
    const { x1, y1, x2, y2, strokeWidth } = s;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(10, strokeWidth * 3) * state.dpr;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - head * Math.cos(angle - Math.PI / 7),
      y2 - head * Math.sin(angle - Math.PI / 7)
    );
    ctx.lineTo(
      x2 - head * Math.cos(angle + Math.PI / 7),
      y2 - head * Math.sin(angle + Math.PI / 7)
    );
    ctx.closePath();
    ctx.fill();
  }

  function drawSelection(ctx, s) {
    const pad = 6 * state.dpr;
    const minX = Math.min(s.x1, s.x2) - pad;
    const minY = Math.min(s.y1, s.y2) - pad;
    const w = Math.abs(s.x2 - s.x1) + pad * 2;
    const h = Math.abs(s.y2 - s.y1) + pad * 2;

    ctx.save();
    ctx.setLineDash([4 * state.dpr, 4 * state.dpr]);
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = state.dpr;
    ctx.strokeRect(minX, minY, w, h);
    ctx.restore();
  }

  /* =======================================================================
   * Hit-testing
   * ======================================================================= */

  function hitTest(x, y) {
    for (let i = state.shapes.length - 1; i >= 0; i--) {
      const s = state.shapes[i];
      if (shapeContains(s, x, y)) return s;
    }
    return null;
  }

  function shapeContains(s, x, y) {
    const minX = Math.min(s.x1, s.x2);
    const minY = Math.min(s.y1, s.y2);
    const maxX = Math.max(s.x1, s.x2);
    const maxY = Math.max(s.y1, s.y2);

    const pad = (HIT_THRESHOLD + s.strokeWidth / 2) * state.dpr;

    if (s.type === 'rect' || s.type === 'ellipse') {
      const insideOuter = x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad;
      if (!insideOuter) return false;
      if (s.fillColor) return true;
      const insideInner = x > minX + pad && x < maxX - pad && y > minY + pad && y < maxY - pad;
      return !insideInner;
    }

    if (s.type === 'highlight' || s.type === 'redact' || s.type === 'blur') {
      return x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad;
    }

    if (s.type === 'line' || s.type === 'arrow') {
      return distanceToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= pad;
    }

    if (s.type === 'marker') {
      if (!s.points || s.points.length < 2) return false;
      for (let i = 1; i < s.points.length; i++) {
        const [ax, ay] = s.points[i - 1];
        const [bx, by] = s.points[i];
        if (distanceToSegment(x, y, ax, ay, bx, by) <= pad) return true;
      }
      return false;
    }

    if (s.type === 'badge') {
      const r = BADGE_RADIUS * state.dpr;
      return Math.hypot(x - s.x1, y - s.y1) <= r + pad;
    }

    if (s.type === 'text') {
      return x >= s.x1 - pad && x <= (s.x2 || s.x1 + 40) + pad
          && y >= s.y1 - pad && y <= (s.y2 || s.y1 + 30) + pad;
    }

    return false;
  }

  function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /* =======================================================================
   * Pointer events
   * ======================================================================= */

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  canvas.addEventListener('dblclick', (e) => {
    const p = canvasPoint(e);
    const hit = hitTest(p.x, p.y);
    if (hit && hit.type === 'text') {
      openTextEditor(hit.x1, hit.y1, hit);
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    const p = canvasPoint(e);
    canvas.setPointerCapture(e.pointerId);

    if (state.tool === 'select') {
      const hit = hitTest(p.x, p.y);
      if (hit) {
        state.selectedId = hit.id;
        state.dragging = { id: hit.id, offsetX: p.x, offsetY: p.y };
      } else {
        state.selectedId = null;
      }
      render();
      return;
    }

    if (state.tool === 'eyedropper') {
      pickColorAt(p.x, p.y);
      return;
    }

    if (state.tool === 'text') {
      openTextEditor(p.x, p.y, null);
      return;
    }

    state.selectedId = null;
    if (state.tool === 'badge') {
      const nextNum = state.shapes
        .filter((s) => s.type === 'badge')
        .reduce((max, s) => Math.max(max, s.number || 0), 0) + 1;
      const badge = {
        id: 'shape-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        type: 'badge',
        x1: p.x, y1: p.y,
        x2: p.x, y2: p.y,
        number: nextNum,
        color: state.color,
        strokeWidth: 0,
      };
      state.shapes.push(badge);
      pushHistory();
      render();
      return;
    }
    if (state.tool === 'marker') {
      state.draft = {
        id: 'draft',
        type: 'marker',
        points: [[p.x, p.y]],
        x1: p.x, y1: p.y, x2: p.x, y2: p.y,
        color: state.color,
        strokeWidth: state.strokeWidth,
      };
    } else {
      state.draft = {
        id: 'draft',
        type: state.tool,
        x1: p.x, y1: p.y,
        x2: p.x, y2: p.y,
        color: state.color,
        fillColor: FILLABLE_TOOLS.has(state.tool) ? state.fillColor : null,
        strokeWidth: state.strokeWidth,
        blurRadius: state.tool === 'blur' ? state.blurRadius : undefined,
      };
    }
    render();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = canvasPoint(e);

    if (state.tool === 'select' && state.dragging) {
      const shape = state.shapes.find((s) => s.id === state.dragging.id);
      if (shape) {
        const dx = p.x - state.dragging.offsetX;
        const dy = p.y - state.dragging.offsetY;
        shape.x1 += dx;
        shape.x2 += dx;
        shape.y1 += dy;
        shape.y2 += dy;
        if (shape.points) {
          for (const pt of shape.points) {
            pt[0] += dx;
            pt[1] += dy;
          }
        }
        state.dragging.offsetX = p.x;
        state.dragging.offsetY = p.y;
        render();
      }
      return;
    }

    if (state.tool === 'select' && !state.dragging) {
      const hit = hitTest(p.x, p.y);
      canvas.classList.toggle('over-shape', !!hit);
      return;
    }

    if (state.draft) {
      if (state.draft.type === 'marker') {
        const last = state.draft.points[state.draft.points.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) > 1) {
          state.draft.points.push([p.x, p.y]);
        }
      } else {
        state.draft.x2 = p.x;
        state.draft.y2 = p.y;
      }
      render();
    }
  });

  canvas.addEventListener('pointerup', () => {
    if (state.tool === 'select' && state.dragging) {
      state.dragging = null;
      pushHistory();
      return;
    }

    if (state.draft) {
      const d = state.draft;
      state.draft = null;
      if (d.type === 'marker') {
        if (d.points.length < 2) { render(); return; }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of d.points) {
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }
        d.x1 = minX; d.y1 = minY; d.x2 = maxX; d.y2 = maxY;
      } else {
        const size = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
        if (size < 3) { render(); return; }
      }
      d.id = 'shape-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      state.shapes.push(d);
      pushHistory();
      render();
    }
  });

  /* =======================================================================
   * History (undo/redo)
   * ======================================================================= */

  function pushHistory() {
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(JSON.stringify(state.shapes));
    state.historyIndex = state.history.length - 1;
    updateHistoryButtons();
  }

  function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex--;
    state.shapes = JSON.parse(state.history[state.historyIndex]);
    state.selectedId = null;
    updateHistoryButtons();
    render();
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    state.shapes = JSON.parse(state.history[state.historyIndex]);
    state.selectedId = null;
    updateHistoryButtons();
    render();
  }

  function updateHistoryButtons() {
    document.getElementById('undo').disabled = state.historyIndex <= 0;
    document.getElementById('redo').disabled = state.historyIndex >= state.history.length - 1;
  }

  /* =======================================================================
   * UI bindings
   * ======================================================================= */

  function setTool(tool) {
    if (tool !== 'eyedropper') state.previousTool = tool;
    state.tool = tool;
    document.querySelectorAll('#tools .tool').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    canvas.classList.toggle('tool-select', tool === 'select');
    canvas.classList.toggle('tool-draw', tool !== 'select');
    canvas.classList.toggle('tool-eyedropper', tool === 'eyedropper');
    canvas.classList.remove('over-shape');
    const showFill = FILLABLE_TOOLS.has(tool);
    document.getElementById('fills').hidden = !showFill;
    document.getElementById('fillDivider').hidden = !showFill;
    const showBlur = tool === 'blur';
    document.getElementById('blurIntensity').hidden = !showBlur;
    document.getElementById('blurDivider').hidden = !showBlur;
    const showFont = tool === 'text';
    document.getElementById('fontSize').hidden = !showFont;
    document.getElementById('fontDivider').hidden = !showFont;
    canvas.classList.toggle('tool-text', tool === 'text');
  }

  function setFontSize(px) {
    state.fontSize = px;
    document.querySelectorAll('#fontSize [data-font]').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.font) === px);
    });
  }

  function setBlurRadius(r) {
    state.blurRadius = r;
    document.querySelectorAll('#blurIntensity [data-blur]').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.blur) === r);
    });
  }

  function openTextEditor(canvasX, canvasY, existing) {
    if (state.textEditing) commitTextEditor();

    const wrap = canvas.parentElement;
    const canvasRect = canvas.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();

    const scaleX = canvasRect.width / canvas.width;
    const scaleY = canvasRect.height / canvas.height;

    const cssX = canvasX * scaleX + (canvasRect.left - wrapRect.left) + wrap.scrollLeft;
    const cssY = canvasY * scaleY + (canvasRect.top - wrapRect.top) + wrap.scrollTop;

    const fontSize = existing ? existing.fontSize : state.fontSize;
    const color = existing ? existing.color : state.color;

    const ta = document.createElement('textarea');
    ta.className = 'text-overlay';
    ta.value = existing ? existing.text : '';
    ta.style.left = cssX + 'px';
    ta.style.top = cssY + 'px';
    ta.style.fontSize = fontSize + 'px';
    ta.style.color = color;
    ta.rows = 1;
    wrap.appendChild(ta);

    const autoSize = () => {
      ta.style.width = 'auto';
      ta.style.height = 'auto';
      ta.style.width = Math.max(60, ta.scrollWidth + 4) + 'px';
      ta.style.height = Math.max(fontSize * 1.3, ta.scrollHeight) + 'px';
    };
    autoSize();
    ta.addEventListener('input', autoSize);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelTextEditor(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitTextEditor(); }
    });
    ta.addEventListener('blur', commitTextEditor);

    state.textEditing = {
      textarea: ta,
      canvasX, canvasY,
      existing,
      fontSize,
      color,
    };

    setTimeout(() => ta.focus(), 0);
  }

  function commitTextEditor() {
    const e = state.textEditing;
    if (!e) return;
    const text = e.textarea.value;
    e.textarea.remove();
    state.textEditing = null;

    if (!text.trim()) {
      if (e.existing) {
        state.shapes = state.shapes.filter((s) => s.id !== e.existing.id);
        pushHistory();
        render();
      }
      return;
    }

    if (e.existing) {
      e.existing.text = text;
      e.existing.fontSize = e.fontSize;
      e.existing.color = e.color;
    } else {
      state.shapes.push({
        id: 'shape-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        type: 'text',
        text,
        x1: e.canvasX, y1: e.canvasY,
        x2: e.canvasX, y2: e.canvasY,
        fontSize: e.fontSize,
        color: e.color,
      });
    }
    pushHistory();
    render();
  }

  function cancelTextEditor() {
    const e = state.textEditing;
    if (!e) return;
    e.textarea.remove();
    state.textEditing = null;
  }

  function pickColorAt(x, y) {
    const px = Math.max(0, Math.min(canvas.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.round(y)));
    const data = ctx.getImageData(px, py, 1, 1).data;
    const hex = '#' + [data[0], data[1], data[2]]
      .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
      .join('');
    setColor(hex);
    setTool(state.previousTool || 'rect');
  }

  function setFillColor(color) {
    state.fillColor = color || null;
    document.querySelectorAll('#fills .swatch').forEach((btn) => {
      const value = btn.dataset.fill ?? '';
      btn.classList.toggle('active', (state.fillColor || '') === value);
    });
  }

  function setColor(color) {
    state.color = color;
    document.querySelectorAll('#colors .swatch').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.color === color);
    });
    document.getElementById('customColor').value = color;
  }

  function setStroke(w) {
    state.strokeWidth = w;
    document.querySelectorAll('#strokes .stroke').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.stroke) === w);
    });
  }

  function bindUI() {
    document.querySelectorAll('#tools .tool').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    document.querySelectorAll('#strokes .stroke').forEach((btn) => {
      btn.addEventListener('click', () => setStroke(Number(btn.dataset.stroke)));
    });
    document.querySelectorAll('#colors .swatch[data-color]').forEach((btn) => {
      btn.addEventListener('click', () => setColor(btn.dataset.color));
    });
    document.getElementById('customColor').addEventListener('input', (e) => {
      setColor(e.target.value);
    });

    document.querySelectorAll('#fills .swatch').forEach((btn) => {
      if (btn.classList.contains('swatch-custom')) return;
      btn.addEventListener('click', () => setFillColor(btn.dataset.fill || null));
    });
    document.getElementById('customFill').addEventListener('input', (e) => {
      setFillColor(e.target.value);
    });

    document.querySelectorAll('#blurIntensity [data-blur]').forEach((btn) => {
      btn.addEventListener('click', () => setBlurRadius(Number(btn.dataset.blur)));
    });

    document.querySelectorAll('#fontSize [data-font]').forEach((btn) => {
      btn.addEventListener('click', () => setFontSize(Number(btn.dataset.font)));
    });

    document.getElementById('undo').addEventListener('click', undo);
    document.getElementById('redo').addEventListener('click', redo);
    document.getElementById('save').addEventListener('click', save);
    document.getElementById('cancel').addEventListener('click', cancel);

    window.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (meta && (e.key.toLowerCase() === 'z' && e.shiftKey || e.key.toLowerCase() === 'y')) { e.preventDefault(); redo(); return; }
    if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.key === 'Escape') {
      if (state.selectedId) { state.selectedId = null; render(); }
      else cancel();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
      e.preventDefault();
      state.shapes = state.shapes.filter((s) => s.id !== state.selectedId);
      state.selectedId = null;
      pushHistory();
      render();
      return;
    }
    const map = { v: 'select', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', h: 'highlight', m: 'marker', x: 'redact', n: 'badge', i: 'eyedropper', b: 'blur', t: 'text' };
    if (!meta && map[e.key.toLowerCase()]) {
      setTool(map[e.key.toLowerCase()]);
    }
  }

  /* =======================================================================
   * Save / Cancel
   * ======================================================================= */

  async function save() {
    if (state.textEditing) commitTextEditor();
    state.selectedId = null;
    render();

    let clipboardPromise = null;
    if (state.copyToClipboard) {
      clipboardPromise = navigator.clipboard.write([
        new ClipboardItem({
          'image/png': new Promise((resolve) => canvas.toBlob(resolve, 'image/png')),
        }),
      ]).then(() => true).catch((err) => {
        console.error('Clipboard write from editor failed:', err);
        return false;
      });
    }

    const dataUrl = canvas.toDataURL('image/png');
    const clipboardOk = clipboardPromise ? await clipboardPromise : true;

    await chrome.runtime.sendMessage({
      action: 'editorSave',
      dataUrl,
      hostname: state.hostname,
      copyToClipboard: state.copyToClipboard && !clipboardOk,
    });
    await chrome.storage.session.remove('editor.image');
    window.close();
  }

  async function cancel() {
    await chrome.storage.session.remove('editor.image');
    window.close();
  }

  boot();
})();
