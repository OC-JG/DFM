/* Small DOM helpers. Nothing clever — just the three or four things this app
   does constantly, in one place. */

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/*
 * Escape text destined for an innerHTML template.
 *
 * Check details are authored in this codebase and intentionally contain
 * markup, so they go in raw. Anything originating outside — file names, STEP
 * body names — goes through here. The original interpolated file names
 * straight into innerHTML, so a part called `<img onerror=...>.stl` executed
 * script on load.
 */
export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Build an element in one call: el('div', { class: 'x' }, 'text' | node | [...]) */
export function el(tag, attrs = {}, children = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  if (children != null) {
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return node;
}

/* Replace a container's contents in one reflow. */
export function replaceChildren(container, nodes) {
  const frag = document.createDocumentFragment();
  for (const n of [].concat(nodes)) if (n) frag.appendChild(n);
  container.replaceChildren(frag);
}

/*
 * Toast messages, replacing the original's alert() calls. A modal alert on a
 * failed file parse forces a click before the user can even see which file
 * they dropped.
 */
export function toast(message, kind = 'info', timeout = 6000) {
  let host = $('toastHost');
  if (!host) {
    host = el('div', { id: 'toastHost', class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  const node = el('div', { class: `toast toast-${kind}` }, [
    el('span', { class: 'toast-msg', text: message }),
    el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: () => node.remove() }),
  ]);
  host.appendChild(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

/* Yield to the event loop so the browser can paint. */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
