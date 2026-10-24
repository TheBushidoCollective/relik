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
 * - Bounded op-trace of canvas mutations and visible canvas end-of-paint pixel alpha
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
  let paintIndex = 0;

  const opTrace = [];
  const MAX_OP_TRACE = 5000;

  function recordOp(op) {
    if (paintIndex <= 2 && opTrace.length < MAX_OP_TRACE) {
      opTrace.push({
        ...op,
        t: Date.now(),
      });
    }
  }

  function isVisibleCanvasDirect(canvas) {
    if (!canvas) return false;
    if (canvas.classList && canvas.classList.contains('otio-canvas')) return true;
    if (canvas.className && typeof canvas.className === 'string' && canvas.className.includes('otio-canvas')) return true;
    return false;
  }

  function resolveCanvasRole(canvas, rec) {
    if (!canvas || !rec) return;
    if (isVisibleCanvasDirect(canvas)) {
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
    return rec;
  }

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

  // Intercept HTMLCanvasElement.prototype.getContext
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, options) {
    const res = nativeGetContext.apply(this, arguments);
    let rec = canvasWeakMap.get(this);
    if (!rec) {
      rec = registerCanvas(this, this.width, this.height);
    }
    resolveCanvasRole(this, rec);
    recordOp({
      op: 'getContext',
      canvasId: rec.id,
      role: rec.role,
      isVisible: isVisibleCanvasDirect(this),
      contextType: type,
    });
    return res;
  };

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
        recordOp({
          op: 'set_width',
          canvasId: rec.id,
          role: rec.role,
          isVisible: isVisibleCanvasDirect(this),
          value: val,
        });
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
        recordOp({
          op: 'set_height',
          canvasId: rec.id,
          role: rec.role,
          isVisible: isVisibleCanvasDirect(this),
          value: val,
        });
        rec.height = this.height;
        recomputeOffscreenPixels();
      },
    });
  }

  let inPaint = false;
  let currentPaint = null;
  const completedPaints = [];

  const nativeFillRect = CanvasRenderingContext2D.prototype.fillRect;
  const nativeClearRect = CanvasRenderingContext2D.prototype.clearRect;
  const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  const nativeGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  function isVisibleCanvas(ctx) {
    return isVisibleCanvasDirect(ctx.canvas);
  }

  CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
    const isVis = isVisibleCanvas(this);
    let rec = canvasWeakMap.get(this.canvas);
    if (!rec) rec = registerCanvas(this.canvas, this.canvas.width, this.canvas.height);
    resolveCanvasRole(this.canvas, rec);

    recordOp({
      op: 'fillRect',
      canvasId: rec.id,
      role: rec.role,
      isVisible: isVis,
      x, y, w, h,
      fillStyle: String(this.fillStyle),
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
    });

    if (isVis) {
      inPaint = true;
      paintIndex++;
      currentPaint = {
        paintIndex,
        offscreenCanvasIdsUsed: [],
        leafFills: 0,
        clears: 0,
        draws: 0,
        complete: false,
      };
    } else if (inPaint && currentPaint) {
      const style = String(this.fillStyle).toLowerCase().trim();
      const isBlack = style === '#000000' || style === '#000' || style === 'black' || style === 'rgb(0, 0, 0)' || style === 'rgba(0, 0, 0, 1)';
      if (isBlack) {
        currentPaint.leafFills++;
      }
      if (rec && !currentPaint.offscreenCanvasIdsUsed.includes(rec.id)) {
        currentPaint.offscreenCanvasIdsUsed.push(rec.id);
      }
    }
    return nativeFillRect.apply(this, arguments);
  };

  CanvasRenderingContext2D.prototype.clearRect = function(x, y, w, h) {
    const isVis = isVisibleCanvas(this);
    let rec = canvasWeakMap.get(this.canvas);
    if (!rec) rec = registerCanvas(this.canvas, this.canvas.width, this.canvas.height);
    resolveCanvasRole(this.canvas, rec);

    recordOp({
      op: 'clearRect',
      canvasId: rec.id,
      role: rec.role,
      isVisible: isVis,
      x, y, w, h,
    });

    if (inPaint && currentPaint && !isVis) {
      currentPaint.clears++;
      if (rec && !currentPaint.offscreenCanvasIdsUsed.includes(rec.id)) {
        currentPaint.offscreenCanvasIdsUsed.push(rec.id);
      }
    }
    return nativeClearRect.apply(this, arguments);
  };

  CanvasRenderingContext2D.prototype.drawImage = function(image, ...rest) {
    const isVis = isVisibleCanvas(this);
    let rec = canvasWeakMap.get(this.canvas);
    if (!rec) rec = registerCanvas(this.canvas, this.canvas.width, this.canvas.height);
    resolveCanvasRole(this.canvas, rec);

    const sourceRec = (image instanceof HTMLCanvasElement) ? canvasWeakMap.get(image) : null;
    const sourceId = sourceRec ? sourceRec.id : (image && image.tagName ? image.tagName : 'unknown');

    recordOp({
      op: 'drawImage',
      canvasId: rec.id,
      role: rec.role,
      isVisible: isVis,
      sourceId,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
    });

    if (inPaint && currentPaint && !isVis) {
      currentPaint.draws++;
      if (rec && !currentPaint.offscreenCanvasIdsUsed.includes(rec.id)) {
        currentPaint.offscreenCanvasIdsUsed.push(rec.id);
      }
    }

    const ret = nativeDrawImage.apply(this, arguments);
    if (isVis && inPaint && currentPaint) {
      currentPaint.complete = true;
      completedPaints.push(currentPaint);
      inPaint = false;

      // Sample center pixel immediately after visible canvas drawImage (bounded to paint 1)
      if (pIdx === 1) {
        try {
          const sample = nativeGetImageData.call(this, 480, 270, 1, 1);
          recordOp({
            op: 'visible_paint_end_pixel',
            canvasId: rec ? rec.id : -1,
            paintIndex: pIdx,
            centerAlpha: sample.data[3],
            centerRgba: [sample.data[0], sample.data[1], sample.data[2], sample.data[3]],
          });
        } catch {}
      }
    }

    return ret;
  };

  CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh, settings) {
    const res = nativeGetImageData.apply(this, arguments);
    const rec = canvasWeakMap.get(this.canvas);
    recordOp({
      op: 'getImageData',
      canvasId: rec ? rec.id : -1,
      role: rec ? rec.role : 'unknown',
      isVisible: isVisibleCanvas(this),
      sx, sy, sw, sh,
    });
    return res;
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
    getOpTrace() {
      return opTrace;
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
  };
})();
`;
