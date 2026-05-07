chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'stitch') {
    stitchCaptures(msg);
    return;
  }
  if (msg.action === 'crop') {
    cropRegion(msg);
    return;
  }
  if (msg.action === 'copyToClipboard') {
    copyImageToClipboard(msg.dataUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function stitchCaptures({ captures, hostname, totalHeight, viewportWidth, viewportHeight, devicePixelRatio, copyToClipboard, mode }) {
  const dpr = devicePixelRatio;

  const canvas = document.createElement('canvas');
  canvas.width = viewportWidth;
  canvas.height = totalHeight;
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < captures.length; i++) {
    const { dataUrl, scrollY } = captures[i];
    const img = await loadImage(dataUrl);

    let coveredUpTo = 0;
    if (i > 0) {
      const prev = captures[i - 1];
      coveredUpTo = prev.scrollY + viewportHeight;
    }

    const overlap = Math.max(0, coveredUpTo - scrollY);

    const srcX = 0;
    const srcY = overlap * dpr;
    const srcW = img.width;
    const srcH = img.height - srcY;

    const dstX = 0;
    const dstY = scrollY + overlap;
    const dstW = viewportWidth;
    const dstH = (srcH / dpr);

    ctx.drawImage(img, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
  }

  const resultDataUrl = canvas.toDataURL('image/jpeg', 0.85);

  chrome.runtime.sendMessage({
    action: 'stitchComplete',
    dataUrl: resultDataUrl,
    hostname,
    copyToClipboard,
    mode,
  });
}

async function cropRegion({ dataUrl, rect, hostname, copyToClipboard, editBeforeSave, mode }) {
  const img = await loadImage(dataUrl);
  const dpr = rect.dpr || 1;

  const srcX = Math.max(0, Math.round(rect.x * dpr));
  const srcY = Math.max(0, Math.round(rect.y * dpr));
  const srcW = Math.min(img.width - srcX, Math.round(rect.w * dpr));
  const srcH = Math.min(img.height - srcY, Math.round(rect.h * dpr));

  const canvas = document.createElement('canvas');
  canvas.width = srcW;
  canvas.height = srcH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

  const resultDataUrl = canvas.toDataURL('image/png');

  chrome.runtime.sendMessage({
    action: 'stitchComplete',
    dataUrl: resultDataUrl,
    hostname,
    copyToClipboard,
    editBeforeSave,
    mode,
    width: srcW,
    height: srcH,
    cssWidth: Math.round(rect.w),
    cssHeight: Math.round(rect.h),
    dpr,
  });
}

async function copyImageToClipboard(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const pngBlob = blob.type === 'image/png' ? blob : await convertToPng(dataUrl);
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('Clipboard API not available in offscreen context');
  }
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': pngBlob }),
  ]);
}

async function convertToPng(dataUrl) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}
