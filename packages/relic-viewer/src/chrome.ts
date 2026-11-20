/**
 * The pieces of chrome the viewer and the publish page both draw.
 *
 * Nothing here decides anything. It is the wordmark, the inline icons, the
 * button and the toast, kept in one file so the two pages cannot drift into
 * two idioms for the same control.
 */

/**
 * The wordmark in the accession band.
 *
 * The recipient is deciding whether to trust an unfamiliar domain, so the
 * wordmark is the domain itself rather than a product name they have no way to
 * connect to the address bar. It is a brand fact and belongs in code: deriving
 * it from the serving origin would print whatever host the deployment happens
 * to answer on.
 */
export const WORDMARK = 'relik.link';

export const ICONS = {
  copy: 'M5 2h7a1 1 0 0 1 1 1v8h-1V3H5V2zM3 4h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 1v8h7V5H3z',
  download:
    'M7.5 1h1v7.3l2.6-2.6.7.7L8 10.2 4.2 6.4l.7-.7 2.6 2.6V1zM2 12h12v1H2v-1z',
  upload:
    'M8 1.8l3.8 3.8-.7.7-2.6-2.6V11h-1V3.7L4.9 6.3l-.7-.7L8 1.8zM2 12h12v1H2v-1z',
  source:
    'M5.7 3.3 2 7l3.7 3.7.7-.7L3.4 7l3-3-.7-.7zm4.6 0-.7.7 3 3-3 3 .7.7L14 7l-3.7-3.7z',
  rendered: 'M2 3h12v1H2V3zm0 3h12v1H2V6zm0 3h8v1H2V9zm0 3h10v1H2v-1z',
  flag: 'M3 1h1v14H3V1zm2 1h8l-2 3 2 3H5V2z',
} as const;

export function icon(path: string): SVGSVGElement {
  // Inline SVG rather than an emoji or a webfont: the CSP blocks external
  // anything, and an emoji is not an icon system.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

export function button(
  label: string,
  iconPath: string,
  onClick: () => void
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'action';
  element.appendChild(icon(iconPath));
  const text = document.createElement('span');
  text.textContent = label;
  element.appendChild(text);
  element.addEventListener('click', onClick);
  return element;
}

export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = 'toast';
  element.setAttribute('role', 'status');
  element.textContent = message;
  document.body.appendChild(element);
  window.setTimeout(() => element.remove(), 4000);
}
