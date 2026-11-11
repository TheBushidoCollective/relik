/**
 * A fixed, numeric-only inspection surface. The worker receives a bounded
 * transfer copy, never the relic context; Three receives only validated mesh
 * positions. No model text, resource reference, material or shader reaches DOM.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  PerspectiveCamera,
  Scene,
  Spherical,
  Vector3,
  WebGLRenderer,
  TOUCH,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type {
  ModelErrorCode,
  ModelFormat,
  ModelParseRequest,
  ModelParseResponse,
  ModelWarning,
} from './model-parse.ts';
import type { RelicContent } from './content.ts';

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_TRIANGLES = 250_000;
const MAX_BACKING_PIXELS = 4_000_000;
const PARSER_DEADLINE_MS = 10_000;
const ROTATION_STEP = Math.PI / 12;

const PARSE_ERRORS: Record<ModelErrorCode, readonly [string, string]> = {
  'invalid-format': [
    'Unsupported model format',
    'Interactive viewing supports STL and OBJ polygon meshes.',
  ],
  'invalid-data': [
    'Malformed model',
    'The file does not contain a valid triangle mesh.',
  ],
  'unsupported-geometry': [
    'Unsupported geometry',
    'Lines, points, curves and surfaces cannot be shown as a polygon mesh.',
  ],
  'non-planar-face': [
    'Non-planar polygon',
    'A polygon does not lie in one plane. The model has not been rendered.',
  ],
  'self-intersecting-face': [
    'Self-intersecting polygon',
    'A polygon crosses itself. The model has not been rendered.',
  ],
  'limit-exceeded': [
    'Model exceeds interactive limits',
    'The model is too large or complex for interactive viewing.',
  ],
  'internal-error': [
    'Could not read model',
    'The model parser could not complete.',
  ],
};

const WARNINGS: Record<ModelWarning, string> = {
  'geometry-only':
    'Geometry only. Materials, textures and colors are not shown.',
  'color-ignored': 'Geometry only. Color extensions are not shown.',
};

const ARROWS = {
  left: 'M10 3 5 8l5 5',
  up: 'm3 10 5-5 5 5',
  down: 'm3 6 5 5 5-5',
  right: 'm6 3 5 5-5 5',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
} as const;

let nextViewId = 0;

type ParsedModel = Extract<ModelParseResponse, { ok: true }>;
type Movement = 'orbit' | 'pan';

type Graphics = {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  radius: number;
  maxWidth: number;
  maxHeight: number;
};

/** Check the data-only worker envelope without rendering worker error text. */
function modelResponse(value: unknown): ModelParseResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (data['type'] !== 'result' || data['id'] !== 1) return null;
  if (data['ok'] === false) {
    return typeof data['error'] === 'string' &&
      Object.hasOwn(PARSE_ERRORS, data['error'])
      ? (value as ModelParseResponse)
      : null;
  }
  if (data['ok'] !== true || !Array.isArray(data['warnings'])) return null;
  if (
    data['warnings'].length > 2 ||
    !data['warnings'].every(
      (code) => typeof code === 'string' && Object.hasOwn(WARNINGS, code)
    )
  ) {
    return null;
  }
  const positions = data['positions'];
  if (
    !(positions instanceof Float32Array) ||
    !(positions.buffer instanceof ArrayBuffer) ||
    positions.byteOffset !== 0 ||
    positions.byteLength !== positions.buffer.byteLength ||
    positions.length === 0 ||
    positions.length % 9 !== 0 ||
    positions.length > MAX_TRIANGLES * 9
  ) {
    return null;
  }
  const bounds = data['bounds'];
  if (typeof bounds !== 'object' || bounds === null) return null;
  const { min, max } = bounds as Record<string, unknown>;
  if (
    !Array.isArray(min) ||
    !Array.isArray(max) ||
    min.length !== 3 ||
    max.length !== 3
  ) {
    return null;
  }
  for (let axis = 0; axis < 3; axis++) {
    if (
      typeof min[axis] !== 'number' ||
      typeof max[axis] !== 'number' ||
      !Number.isFinite(min[axis]) ||
      !Number.isFinite(max[axis]) ||
      min[axis] > max[axis]
    ) {
      return null;
    }
  }
  return value as ParsedModel;
}

/**
 * Mount one model. The caller owns the content and Download, and must call the
 * returned disposer when replacing a stage or historical version.
 */
export function mountModelView(
  container: HTMLElement,
  format: ModelFormat,
  content: RelicContent
): () => void {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error('The model viewer requires a browser document.');
  const events = new AbortController();
  const signal = events.signal;
  const id = `model-help-${++nextViewId}`;
  let disposed = false;
  let failed = false;
  let worker: Worker | null = null;
  let deadline: number | undefined;
  let frame = 0;
  let graphics: Graphics | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let movement: Movement = 'orbit';
  let firstDraw = false;

  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const root = element('section', 'model-view');
  root.dataset['ready'] = 'false';
  root.dataset['modelState'] = 'loading';
  root.setAttribute('aria-label', '3D model');
  root.setAttribute('aria-busy', 'true');
  const toolbar = element('div', 'model-toolbar');
  const displayModes = element('div', 'model-button-group');
  displayModes.setAttribute('role', 'group');
  displayModes.setAttribute('aria-label', 'Model display');

  function button(
    text: string,
    action: () => void,
    icon?: keyof typeof ARROWS
  ): HTMLButtonElement {
    const node = element('button', 'model-button', icon ? undefined : text);
    node.type = 'button';
    node.disabled = true;
    node.setAttribute('aria-label', text);
    node.title = text;
    if (icon) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', ARROWS[icon]);
      svg.appendChild(path);
      node.appendChild(svg);
      node.classList.add('model-icon-button');
    }
    node.addEventListener('click', action, { signal });
    return node;
  }

  const solid = button('Solid', () => setWireframe(false));
  const wireframe = button('Wireframe', () => setWireframe(true));
  solid.setAttribute('aria-pressed', 'true');
  wireframe.setAttribute('aria-pressed', 'false');
  displayModes.append(solid, wireframe);
  const reset = button('Reset', resetCamera);
  reset.classList.add('model-reset');
  reset.setAttribute('aria-keyshortcuts', 'Home');
  toolbar.append(displayModes, reset);

  const viewport = element('div', 'model-viewport');
  const canvas = element('canvas', 'model-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Interactive 3D model');
  canvas.setAttribute('aria-describedby', id);
  canvas.setAttribute(
    'aria-keyshortcuts',
    'ArrowLeft ArrowRight ArrowUp ArrowDown Home W + -'
  );
  const status = element('div', 'model-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const statusTitle = element('p', 'model-status-title', 'Loading 3D model');
  const statusDetail = element('p', 'model-status-detail');
  status.append(statusTitle, statusDetail);
  viewport.append(canvas, status);

  const measures = element('div', 'model-measures');
  measures.hidden = true;
  const triangles = element('span', 'model-triangles');
  const extents = element('span', 'model-extents');
  measures.append(triangles, extents);
  const warnings = element('div', 'model-warnings');
  warnings.setAttribute('role', 'status');
  warnings.hidden = true;

  const navigation = element('div', 'model-navigation');
  const moveModes = element('div', 'model-button-group');
  moveModes.setAttribute('role', 'group');
  moveModes.setAttribute('aria-label', 'Model movement');
  const orbit = button('Orbit', () => setMovement('orbit'));
  const pan = button('Pan', () => setMovement('pan'));
  orbit.setAttribute('aria-pressed', 'true');
  pan.setAttribute('aria-pressed', 'false');
  moveModes.append(orbit, pan);
  const directions = element('div', 'model-button-group model-directions');
  directions.setAttribute('role', 'group');
  directions.setAttribute('aria-label', 'Orbit directions');
  const directionButtons = [
    button('Orbit left', () => move(-1, 0, movement), 'left'),
    button('Orbit up', () => move(0, -1, movement), 'up'),
    button('Orbit down', () => move(0, 1, movement), 'down'),
    button('Orbit right', () => move(1, 0, movement), 'right'),
  ];
  directions.append(...directionButtons);
  const zoom = element('div', 'model-button-group');
  zoom.setAttribute('role', 'group');
  zoom.setAttribute('aria-label', 'Zoom');
  zoom.append(
    button('Zoom out', () => zoomCamera(1.2), 'minus'),
    button('Zoom in', () => zoomCamera(1 / 1.2), 'plus')
  );
  navigation.append(moveModes, directions, zoom);

  const help = element('details', 'model-help');
  const summary = element('summary', '', 'Keyboard and touch controls');
  const instructions = element(
    'p',
    '',
    'Arrow keys rotate. Shift + arrow keys pan. + and - zoom. Home resets. W switches wireframe. Drag to orbit or pan; two fingers pan and zoom.'
  );
  instructions.id = id;
  help.append(summary, instructions);
  const legend = element(
    'p',
    'model-legend',
    'Shown as a 3D model, no author code.'
  );
  root.append(toolbar, viewport, measures, warnings, navigation, help, legend);
  container.replaceChildren(root);

  const stylesheet = doc.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/assets/model-view.css';
  stylesheet.addEventListener('load', scheduleRender, { signal });
  stylesheet.addEventListener(
    'error',
    () =>
      fail(
        'renderer-unavailable',
        'Could not load model viewer',
        'The model viewing component could not be loaded.'
      ),
    { signal }
  );
  doc.head.appendChild(stylesheet);

  const offset = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const translation = new Vector3();
  const spherical = new Spherical();
  const initialDirection = new Vector3(1, 0.7, 1).normalize();
  const theme = win.matchMedia('(prefers-color-scheme: dark)');

  function stopWorker(): void {
    if (deadline !== undefined) {
      win?.clearTimeout(deadline);
      deadline = undefined;
    }
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = null;
    }
  }

  function releaseGraphics(): void {
    if (frame) win?.cancelAnimationFrame(frame);
    frame = 0;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (!graphics) return;
    const current = graphics;
    graphics = null;
    current.controls.dispose();
    current.geometry.dispose();
    current.material.dispose();
    current.scene.clear();
    current.renderer.renderLists.dispose();
    current.renderer.dispose();
    current.renderer.forceContextLoss();
    canvas.width = 1;
    canvas.height = 1;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.dataset['disposed'] = 'true';
    stopWorker();
    events.abort();
    releaseGraphics();
    stylesheet.remove();
    root.remove();
  }

  function active(): boolean {
    if (disposed || failed) return false;
    if (
      root.parentNode !== container ||
      container.dataset['disposed'] === 'true'
    ) {
      dispose();
      return false;
    }
    return true;
  }

  function renderState(state: 'ready' | 'error'): void {
    root.dispatchEvent(
      new CustomEvent('relic:render-state', { detail: state, bubbles: true })
    );
  }

  function fail(code: string, title: string, detail: string): void {
    if (!active()) return;
    failed = true;
    stopWorker();
    releaseGraphics();
    root.dataset['ready'] = 'error';
    root.dataset['modelState'] = code;
    root.setAttribute('aria-busy', 'false');
    canvas.hidden = true;
    canvas.tabIndex = -1;
    for (const control of root.querySelectorAll('button'))
      control.disabled = true;
    measures.hidden = true;
    warnings.hidden = true;
    status.hidden = false;
    status.setAttribute('role', 'alert');
    statusTitle.textContent = title;
    statusDetail.textContent = `${detail} Download the original file to inspect it.`;
    renderState('error');
  }

  function failParse(code: ModelErrorCode): void {
    const [title, detail] = PARSE_ERRORS[code];
    fail(code, title, detail);
  }

  function resize(current: Graphics): boolean {
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const ratio = Math.min(
      Math.max(1, win?.devicePixelRatio ?? 1),
      2,
      Math.sqrt(MAX_BACKING_PIXELS / rect.width / rect.height),
      current.maxWidth / rect.width,
      current.maxHeight / rect.height
    );
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      current.renderer.setSize(width, height, false);
    }
    current.camera.aspect = rect.width / rect.height;
    current.camera.updateProjectionMatrix();
    return true;
  }

  function scheduleRender(): void {
    if (!active() || !graphics || frame) return;
    frame = win!.requestAnimationFrame(draw);
  }

  function draw(): void {
    frame = 0;
    if (!active() || !graphics || !root.isConnected) return;
    if (!stylesheet.sheet) return;
    const current = graphics;
    try {
      if (!resize(current)) return;
      if (!firstDraw) fitCamera(current);
      const gl = current.renderer.getContext();
      if (gl.isContextLost()) {
        fail(
          'context-lost',
          'Graphics context lost',
          'The browser stopped rendering this model.'
        );
        return;
      }
      current.renderer.render(current.scene, current.camera);
      if (
        gl.getError() !== gl.NO_ERROR ||
        (current.renderer.info.render.triangles === 0 &&
          current.renderer.info.render.lines === 0)
      ) {
        fail(
          'graphics-error',
          'Could not render model',
          'The graphics renderer could not draw the mesh.'
        );
        return;
      }
      if (!firstDraw) {
        firstDraw = true;
        root.dataset['ready'] = 'true';
        root.dataset['modelState'] = 'ready';
        root.setAttribute('aria-busy', 'false');
        status.hidden = true;
        measures.hidden = false;
        for (const control of root.querySelectorAll('button'))
          control.disabled = false;
        renderState('ready');
      }
    } catch {
      fail(
        'graphics-error',
        'Could not render model',
        'The graphics renderer could not draw the mesh.'
      );
    }
  }

  function fitCamera(current: Graphics): void {
    const vertical = (current.camera.fov * Math.PI) / 180;
    const horizontal =
      2 * Math.atan(Math.tan(vertical / 2) * current.camera.aspect);
    const distance =
      (current.radius * 1.15) / Math.sin(Math.min(vertical, horizontal) / 2);
    current.controls.target.set(0, 0, 0);
    current.camera.position.copy(initialDirection).multiplyScalar(distance);
    current.camera.lookAt(current.controls.target);
    current.controls.minDistance = current.radius * 0.08;
    current.controls.maxDistance = Math.max(current.radius * 100, distance * 2);
    current.camera.near = current.radius * 0.001;
    current.camera.far = current.controls.maxDistance * 4;
    current.camera.updateProjectionMatrix();
    current.controls.update();
  }

  function resetCamera(): void {
    if (!active() || !graphics || !firstDraw) return;
    try {
      if (!resize(graphics)) return;
      fitCamera(graphics);
      scheduleRender();
    } catch {
      fail(
        'graphics-error',
        'Could not render model',
        'The graphics renderer could not draw the mesh.'
      );
    }
  }

  function setWireframe(enabled: boolean): void {
    if (!active() || !graphics || !firstDraw) return;
    graphics.material.wireframe = enabled;
    solid.setAttribute('aria-pressed', String(!enabled));
    wireframe.setAttribute('aria-pressed', String(enabled));
    scheduleRender();
  }

  function setMovement(next: Movement): void {
    if (!active() || !graphics || !firstDraw) return;
    movement = next;
    graphics.controls.mouseButtons.LEFT =
      next === 'pan' ? MOUSE.PAN : MOUSE.ROTATE;
    graphics.controls.touches.ONE = next === 'pan' ? TOUCH.PAN : TOUCH.ROTATE;
    orbit.setAttribute('aria-pressed', String(next === 'orbit'));
    pan.setAttribute('aria-pressed', String(next === 'pan'));
    const label = next === 'orbit' ? 'Orbit' : 'Pan';
    directions.setAttribute('aria-label', `${label} directions`);
    for (const [index, direction] of [
      'left',
      'up',
      'down',
      'right',
    ].entries()) {
      const control = directionButtons[index]!;
      control.setAttribute('aria-label', `${label} ${direction}`);
      control.title = `${label} ${direction}`;
    }
  }

  function move(horizontal: number, vertical: number, mode: Movement): void {
    if (!active() || !graphics || !firstDraw) return;
    const { camera, controls } = graphics;
    offset.copy(camera.position).sub(controls.target);
    if (mode === 'orbit') {
      spherical.setFromVector3(offset);
      spherical.theta -= horizontal * ROTATION_STEP;
      spherical.phi = Math.max(
        0.05,
        Math.min(Math.PI - 0.05, spherical.phi + vertical * ROTATION_STEP)
      );
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
    } else {
      const step =
        offset.length() * Math.tan((camera.fov * Math.PI) / 360) * 0.15;
      camera.updateMatrixWorld();
      right.setFromMatrixColumn(camera.matrix, 0);
      up.setFromMatrixColumn(camera.matrix, 1);
      translation
        .copy(right)
        .multiplyScalar(-horizontal * step)
        .addScaledVector(up, vertical * step);
      camera.position.add(translation);
      controls.target.add(translation);
    }
    controls.update();
    scheduleRender();
  }

  function zoomCamera(factor: number): void {
    if (!active() || !graphics || !firstDraw) return;
    const { camera, controls } = graphics;
    offset.copy(camera.position).sub(controls.target);
    const distance = Math.max(
      controls.minDistance,
      Math.min(controls.maxDistance, offset.length() * factor)
    );
    offset.setLength(distance);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    scheduleRender();
  }

  function paintMaterial(): void {
    if (!active() || !graphics) return;
    const color = win!
      .getComputedStyle(root)
      .getPropertyValue('--ink-soft')
      .trim();
    if (color) graphics.material.color.setStyle(color);
    scheduleRender();
  }

  function mountGeometry(data: ParsedModel): void {
    const { positions, bounds } = data;
    const extent = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ] as const;
    const span = Math.max(...extent);
    if (!Number.isFinite(span) || span <= 0) {
      failParse('invalid-data');
      return;
    }
    const scale = 2 / span;
    const center = bounds.min.map((value, axis) => value + extent[axis]! / 2);
    // Normalize the transferred positions in place, avoiding another mesh copy.
    for (let index = 0; index < positions.length; index++) {
      const axis = index % 3;
      const value = positions[index]!;
      if (
        !Number.isFinite(value) ||
        value < bounds.min[axis]! ||
        value > bounds.max[axis]!
      ) {
        failParse('invalid-data');
        return;
      }
      positions[index] = (value - center[axis]!) * scale;
    }
    let renderer: WebGLRenderer | null = null;
    let geometry: BufferGeometry | null = null;
    let material: MeshStandardMaterial | null = null;
    let controls: OrbitControls | null = null;
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: true,
        depth: true,
        stencil: false,
        powerPreference: 'low-power',
        preserveDrawingBuffer: false,
      });
      if (!gl) {
        fail(
          'webgl-unavailable',
          'WebGL 2 unavailable',
          'This browser cannot display an interactive model.'
        );
        return;
      }
      renderer = new WebGLRenderer({
        canvas,
        context: gl,
        alpha: true,
        antialias: true,
        stencil: false,
      });
      renderer.setClearColor(0x000000, 0);
      geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const radius = Math.hypot(...extent) / span;
      material = new MeshStandardMaterial({
        color: 0x969e9d,
        roughness: 0.75,
        metalness: 0,
        side: DoubleSide,
      });
      const scene = new Scene();
      scene.add(new Mesh(geometry, material));
      scene.add(new HemisphereLight(0xffffff, 0x4a5453, 2));
      const key = new DirectionalLight(0xffffff, 2.5);
      key.position.set(3, 5, 4);
      scene.add(key);
      const fill = new DirectionalLight(0xffffff, 0.7);
      fill.position.set(-4, 1, -2);
      scene.add(fill);
      const camera = new PerspectiveCamera(38, 1, 0.001, 1000);
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = false;
      controls.autoRotate = false;
      controls.screenSpacePanning = true;
      controls.minPolarAngle = 0.05;
      controls.maxPolarAngle = Math.PI - 0.05;
      controls.touches.TWO = TOUCH.DOLLY_PAN;
      controls.addEventListener('change', scheduleRender);
      const viewportLimits = gl.getParameter(
        gl.MAX_VIEWPORT_DIMS
      ) as Int32Array;
      const textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const renderbufferLimit = gl.getParameter(
        gl.MAX_RENDERBUFFER_SIZE
      ) as number;
      graphics = {
        renderer,
        scene,
        camera,
        controls,
        geometry,
        material,
        radius,
        maxWidth: Math.min(viewportLimits[0]!, textureLimit, renderbufferLimit),
        maxHeight: Math.min(
          viewportLimits[1]!,
          textureLimit,
          renderbufferLimit
        ),
      };
      triangles.textContent = `${(positions.length / 9).toLocaleString()} triangles`;
      const number = new Intl.NumberFormat(undefined, {
        maximumSignificantDigits: 6,
      });
      extents.textContent = `${extent.map((value) => number.format(value)).join(' × ')} file units`;
      const codes = new Set(data.warnings);
      for (const code of codes)
        warnings.appendChild(element('p', '', WARNINGS[code]));
      warnings.hidden = codes.size === 0;
      paintMaterial();
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(scheduleRender);
        resizeObserver.observe(viewport);
      }
      scheduleRender();
    } catch {
      if (!graphics) {
        controls?.dispose();
        geometry?.dispose();
        material?.dispose();
        renderer?.dispose();
        renderer?.forceContextLoss();
        if (!renderer) gl?.getExtension('WEBGL_lose_context')?.loseContext();
      }
      fail(
        'graphics-error',
        'Could not start model viewer',
        'The graphics renderer could not be initialized.'
      );
    }
  }

  container.addEventListener('cleanup', dispose, { signal });
  win.addEventListener('pagehide', dispose, { signal });
  win.addEventListener('resize', scheduleRender, { signal });
  theme.addEventListener('change', paintMaterial, { signal });
  canvas.addEventListener(
    'webglcontextcreationerror',
    (event) => event.preventDefault(),
    { signal }
  );
  canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      fail(
        'context-lost',
        'Graphics context lost',
        'The browser stopped rendering this model.'
      );
    },
    { signal }
  );
  canvas.addEventListener(
    'pointerdown',
    () => {
      if (active() && firstDraw) canvas.focus({ preventScroll: true });
    },
    { signal }
  );
  canvas.addEventListener(
    'keydown',
    (event) => {
      if (
        !active() ||
        !graphics ||
        !firstDraw ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const mode = event.shiftKey ? 'pan' : 'orbit';
      switch (event.key) {
        case 'ArrowLeft':
          move(-1, 0, mode);
          break;
        case 'ArrowRight':
          move(1, 0, mode);
          break;
        case 'ArrowUp':
          move(0, -1, mode);
          break;
        case 'ArrowDown':
          move(0, 1, mode);
          break;
        case '+':
        case '=':
          zoomCamera(1 / 1.2);
          break;
        case '-':
        case '_':
          zoomCamera(1.2);
          break;
        case 'Home':
          resetCamera();
          break;
        case 'w':
        case 'W':
          setWireframe(!graphics.material.wireframe);
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    { signal }
  );

  if (format !== 'stl' && format !== 'obj') {
    failParse('invalid-format');
  } else if (content.size > MAX_SOURCE_BYTES) {
    failParse('limit-exceeded');
  } else {
    void content.readWhole(MAX_SOURCE_BYTES).then(
      (bytes) => {
        if (!active()) return;
        if (!bytes || bytes.byteLength !== content.size) {
          failParse('internal-error');
          return;
        }
        try {
          worker = new Worker('/assets/model-parse-worker.js', {
            type: 'module',
          });
          worker.onmessage = (event: MessageEvent<unknown>) => {
            if (!active()) return;
            stopWorker();
            const response = modelResponse(event.data);
            if (!response) failParse('internal-error');
            else if (!response.ok) failParse(response.error);
            else mountGeometry(response);
          };
          worker.onerror = (event) => {
            event.preventDefault();
            failParse('internal-error');
          };
          worker.onmessageerror = () => failParse('internal-error');
          deadline = win.setTimeout(() => {
            fail(
              'parser-timeout',
              'Model parsing timed out',
              'The model parser exceeded its interactive limit.'
            );
          }, PARSER_DEADLINE_MS);
          const copy = bytes.slice().buffer;
          const request: ModelParseRequest = {
            type: 'parse',
            id: 1,
            format,
            bytes: copy,
          };
          worker.postMessage(request, [copy]);
        } catch {
          failParse('internal-error');
        }
      },
      () => failParse('internal-error')
    );
  }
  return dispose;
}
