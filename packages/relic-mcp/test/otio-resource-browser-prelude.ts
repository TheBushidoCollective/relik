/**
 * Diagnostic-only prelude for OTIO resource and canvas accounting.
 *
 * Injected before navigation via CDP Page.addScriptToEvaluateOnNewDocument.
 * Must not alter drawing arguments, seek behavior, or native return values.
 *
 * Features:
 * - WeakMap canvas accounting (creation counts, width/height setters, visible vs offscreen roles, peak pixels)
 * - Paint lifecycle tracking (fillRect on visible canvas starts paint; drawImage on visible canvas ends paint)
 * - Black leaf fill count per paint
 * - decodeURIComponent call counter restricted to media/holdp00N_<digits>.png (streams via CDP binding every 4096 calls)
 * - Canvas disposal dimension capture across window 'pagehide'
 */

export const PRELUDE_SOURCE = String.raw`(() => {
  if (globalThis.__otioPreludeInstalled) return;
  globalThis.__otioPreludeInstalled = true;

  const canvasWeakMap = new WeakMap();
  const canvasLedger = new Map();
  let nextCanvasId = 1;
  let totalCanvasCreations = 0;
  let currentOffscreenPixels = 0;
  let peakOffscreenPixels = 0;

  const contextEvents = [];

  function isVisibleCanvasEl(canvas) {
    if (!canvas) return false;
    if (canvas.classList && canvas.classList.contains('otio-canvas')) return true;
    if (canvas.className && typeof canvas.className === 'string' && canvas.className.includes('otio-canvas')) return true;
    return false;
  }

  function attachContextListeners(canvas) {
    if (!canvas || typeof canvas.addEventListener !== 'function') return;
    try {
      canvas.addEventListener('contextlost', function(e) {
        // Never call preventDefault
        try {
          const timestamp = performance.timeOrigin + performance.now();
          const rec = canvasWeakMap.get(canvas);
          contextEvents.push({
            type: 'contextlost',
            canvasId: rec ? rec.id : null,
            role: rec ? rec.role : (isVisibleCanvasEl(canvas) ? 'visible' : 'unknown'),
            timestamp,
          });
        } catch {}
      });
      canvas.addEventListener('contextrestored', function(e) {
        try {
          const timestamp = performance.timeOrigin + performance.now();
          const rec = canvasWeakMap.get(canvas);
          contextEvents.push({
            type: 'contextrestored',
            canvasId: rec ? rec.id : null,
            role: rec ? rec.role : (isVisibleCanvasEl(canvas) ? 'visible' : 'unknown'),
            timestamp,
          });
        } catch {}
      });
    } catch {}
  }

  function resolveCanvasRole(canvas, rec) {
    if (!canvas || !rec) return;
    if (isVisibleCanvasEl(canvas)) {
      rec.role = 'visible';
    } else if (rec.role === 'unknown') {
      rec.role = 'offscreen';
    }
  }

  function recomputeOffscreenPixels() {
    let sum = 0;
    for (const rec of canvasLedger.values()) {
      if (rec.role === 'offscreen') {
        sum += (rec.width * rec.height);
      }
    }
    currentOffscreenPixels = sum;
    if (currentOffscreenPixels > peakOffscreenPixels) {
      peakOffscreenPixels = currentOffscreenPixels;
    }
  }

  function registerCanvas(canvas, w, h) {
    totalCanvasCreations++;
    const id = nextCanvasId++;
    const rec = {
      id,
      role: 'unknown',
      width: w,
      height: h,
      createdWidth: w,
      createdHeight: h,
    };
    resolveCanvasRole(canvas, rec);
    canvasWeakMap.set(canvas, rec);
    canvasLedger.set(id, rec);
    if (rec.role === 'offscreen') {
      recomputeOffscreenPixels();
    }
    attachContextListeners(canvas);
    return rec;
  }

  try {
    window.addEventListener('DOMContentLoaded', () => {
      try {
        const vis = document.querySelector('canvas.otio-canvas');
        if (vis) attachContextListeners(vis);
      } catch {}
    });
  } catch {}

  // Intercept document.createElement('canvas')
  const nativeCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function(tagName, options) {
    const el = nativeCreateElement.apply(this, arguments);
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'canvas') {
      registerCanvas(el, el.width, el.height);
    }
    return el;
  };

  // Intercept OffscreenCanvas if present
  if (typeof OffscreenCanvas !== 'undefined') {
    const NativeOffscreenCanvas = globalThis.OffscreenCanvas;
    const WrappedOffscreenCanvas = function(width, height) {
      const el = new NativeOffscreenCanvas(width, height);
      registerCanvas(el, el.width, el.height);
      return el;
    };
    WrappedOffscreenCanvas.prototype = NativeOffscreenCanvas.prototype;
    globalThis.OffscreenCanvas = WrappedOffscreenCanvas;
  }

  // Intercept HTMLCanvasElement.prototype.width and height setters
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');

  if (widthDesc && widthDesc.set && widthDesc.get) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
      configurable: true,
      enumerable: widthDesc.enumerable,
      get() {
        return widthDesc.get.call(this);
      },
      set(val) {
        widthDesc.set.call(this, val);
        let rec = canvasWeakMap.get(this);
        if (!rec) {
          rec = registerCanvas(this, this.width, this.height);
        }
        resolveCanvasRole(this, rec);
        rec.width = this.width;
        recomputeOffscreenPixels();
      },
    });
  }

  if (heightDesc && heightDesc.set && heightDesc.get) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'height', {
      configurable: true,
      enumerable: heightDesc.enumerable,
      get() {
        return heightDesc.get.call(this);
      },
      set(val) {
        heightDesc.set.call(this, val);
        let rec = canvasWeakMap.get(this);
        if (!rec) {
          rec = registerCanvas(this, this.width, this.height);
        }
        resolveCanvasRole(this, rec);
        rec.height = this.height;
        recomputeOffscreenPixels();
      },
    });
  }

  // Paint tracking on CanvasRenderingContext2D
  let inPaint = false;
  let paintIndex = 0;
  let currentPaint = null;
  const completedPaints = [];

  const nativeFillRect = CanvasRenderingContext2D.prototype.fillRect;
  const nativeClearRect = CanvasRenderingContext2D.prototype.clearRect;
  const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;

  function isVisibleCanvas(ctx) {
    const canvas = ctx.canvas;
    return isVisibleCanvasEl(canvas);
  }

  CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
    try {
      if (isVisibleCanvas(this)) {
        const startTs = performance.timeOrigin + performance.now();
        inPaint = true;
        paintIndex++;
        currentPaint = {
          paintIndex,
          offscreenCanvasIdsUsed: [],
          leafFills: 0,
          clears: 0,
          draws: 0,
          complete: false,
          startTime: startTs,
          endTime: null,
          durationMs: null,
        };
      } else if (inPaint && currentPaint) {
        const style = String(this.fillStyle).toLowerCase().trim();
        const isBlack = style === '#000000' || style === '#000' || style === 'black' || style === 'rgb(0, 0, 0)' || style === 'rgba(0, 0, 0, 1)';
        if (isBlack) {
          currentPaint.leafFills++;
        }
        const rec = canvasWeakMap.get(this.canvas);
        if (rec && !currentPaint.offscreenCanvasIdsUsed.includes(rec.id)) {
          currentPaint.offscreenCanvasIdsUsed.push(rec.id);
        }
      }
    } catch {}
    return nativeFillRect.apply(this, arguments);
  };

  CanvasRenderingContext2D.prototype.clearRect = function(x, y, w, h) {
    try {
      if (inPaint && currentPaint && !isVisibleCanvas(this)) {
        currentPaint.clears++;
        const rec = canvasWeakMap.get(this.canvas);
        if (rec && !currentPaint.offscreenCanvasIdsUsed.includes(rec.id)) {
          currentPaint.offscreenCanvasIdsUsed.push(rec.id);
        }
      }
    } catch {}
    return nativeClearRect.apply(this, arguments);
  };

  CanvasRenderingContext2D.prototype.drawImage = function(image, ...rest) {
    let isVis = false;
    try {
      isVis = isVisibleCanvas(this);
      if (isVis && inPaint && currentPaint) {
        const endTs = performance.timeOrigin + performance.now();
        currentPaint.complete = true;
        currentPaint.endTime = endTs;
        currentPaint.durationMs = endTs - (currentPaint.startTime || endTs);
        completedPaints.push(currentPaint);
        inPaint = false;
      } else if (inPaint && currentPaint) {
        currentPaint.draws++;
        const rec = canvasWeakMap.get(this.canvas);
        if (rec && !currentPaint.offscreenCanvasIdsUsed.includes(rec.id)) {
          currentPaint.offscreenCanvasIdsUsed.push(rec.id);
        }
      }
    } catch {}
    const ret = nativeDrawImage.apply(this, arguments);
    try {
      if (isVis) {
        if (globalThis.__otioFaultArm === 'visible-paint-end-1' || globalThis.__otioFaultArm === 'next-visible-paint-end') {
          globalThis.__otioFaultArm = null;
          globalThis.__otioFaultHit = true;
          debugger;
        }
      }
    } catch {}
    return ret;
  };
  // Wrapped decodeURIComponent counter restricted to media/holdp00N_<digits>.png
  const nativeDecodeURIComponent = globalThis.decodeURIComponent;
  let matchingDecodeCount = 0;
  const holdPattern = /^media\/holdp00[0-9]_\d+\.png$/;

  globalThis.decodeURIComponent = function(encodedURI) {
    if (typeof encodedURI === 'string' && holdPattern.test(encodedURI)) {
      matchingDecodeCount++;
      if (matchingDecodeCount % 4096 === 0) {
        if (typeof globalThis.__otioResourceBinding === 'function') {
          try {
            globalThis.__otioResourceBinding(JSON.stringify({
              type: 'decode-count',
              count: matchingDecodeCount,
              timestamp: Date.now(),
            }));
          } catch {}
        }
      }
    }
    return nativeDecodeURIComponent.apply(this, arguments);
  };

  // Disposal snapshots
  let beforeDisposeSnapshot = null;
  let afterDisposeSnapshot = null;

  function takeSnapshot() {
    recomputeOffscreenPixels();
    const surfaces = [];
    for (const rec of canvasLedger.values()) {
      if (rec.role === 'offscreen') {
        surfaces.push({
          id: rec.id,
          role: rec.role,
          width: rec.width,
          height: rec.height,
          pixels: rec.width * rec.height,
        });
      }
    }
    return {
      timestamp: Date.now(),
      totalCanvasesCreated: totalCanvasCreations,
      currentOffscreenPixels,
      peakOffscreenPixels,
      surfaces,
    };
  }

  window.addEventListener('pagehide', () => {
    afterDisposeSnapshot = takeSnapshot();
  });

  globalThis.__otioAccounting = {
    getCanvasStats() {
      recomputeOffscreenPixels();
      let offscreenCreated = 0;
      let visibleCreated = 0;
      for (const rec of canvasLedger.values()) {
        if (rec.role === 'visible') visibleCreated++;
        else offscreenCreated++;
      }
      return {
        creations: totalCanvasCreations,
        offscreenCreated,
        visibleCreated,
        currentOffscreenPixels,
        peakOffscreenPixels,
        paintsCount: completedPaints.length,
        lastPaint: completedPaints.length > 0 ? completedPaints[completedPaints.length - 1] : null,
        paints: completedPaints.slice(-10),
      };
    },
    getDecodeCount() {
      return matchingDecodeCount;
    },
    captureBeforeDispose() {
      beforeDisposeSnapshot = takeSnapshot();
      return beforeDisposeSnapshot;
    },
    captureAfterDispose() {
      afterDisposeSnapshot = takeSnapshot();
      return afterDisposeSnapshot;
    },
    getDisposalEvidence() {
      return {
        before: beforeDisposeSnapshot,
        after: afterDisposeSnapshot,
      };
    },
    resetStats() {
      completedPaints.length = 0;
      inPaint = false;
      currentPaint = null;
    },
    getCanvasPixels() {
      const canvas = document.querySelector('canvas.otio-canvas');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bytes = new Uint8Array(imageData.data.buffer);
      let binary = '';
      const len = bytes.byteLength;
      const chunkSize = 0x8000;
      for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
      }
      return btoa(binary);
    },
    samplePixel(x, y) {
      const canvas = document.querySelector('canvas.otio-canvas');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      return [pixel[0], pixel[1], pixel[2], pixel[3]];
    },
    getContextEvents() {
      return contextEvents.slice();
    },
    readVisibleWithState() {
      const timestamp = performance.timeOrigin + performance.now();
      const canvas = document.querySelector('canvas.otio-canvas');
      if (!canvas) {
        return {
          found: false,
          isContextLost: null,
          width: 0,
          height: 0,
          pixelsBase64: null,
          timestamp,
        };
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return {
          found: true,
          isContextLost: true,
          width: canvas.width,
          height: canvas.height,
          pixelsBase64: null,
          timestamp,
        };
      }
      let isLost = false;
      try {
        isLost = typeof ctx.isContextLost === 'function' ? ctx.isContextLost() : false;
      } catch {
        isLost = true;
      }
      let pixelsBase64 = null;
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const bytes = new Uint8Array(imageData.data.buffer);
        let binary = '';
        const len = bytes.byteLength;
        const chunkSize = 0x8000;
        for (let i = 0; i < len; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
        }
        pixelsBase64 = btoa(binary);
      } catch {
        pixelsBase64 = null;
      }
      return {
        found: true,
        isContextLost: isLost,
        width: canvas.width,
        height: canvas.height,
        pixelsBase64,
        timestamp,
      };
    },
    getPaintDurations() {
      return completedPaints.map(function(p) {
        return {
          paintIndex: p.paintIndex,
          startTime: p.startTime,
          endTime: p.endTime,
          durationMs: p.durationMs,
        };
      });
    },
  };
})();
`;
