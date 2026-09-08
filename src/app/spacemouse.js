/*
 * A 3Dconnexion puck, read through WebHID.
 *
 * ── The question that had to be settled first ────────────────────────────
 *
 * The roadmap left the transport open between WebHID and 3Dconnexion's own
 * local service, and said the deciding fact was whether `navigator.hid` exists
 * at all on a `file://` page — which is how this tool is normally opened —
 * rather than something to assume either way.
 *
 * It does. Chromium treats a file URL as a potentially trustworthy origin, so
 * `window.isSecureContext` is true there and `navigator.hid` is present. That
 * is measured, in the browser test, rather than remembered: it is the kind of
 * fact a Chrome release could change, and if it does the test says so instead
 * of the feature quietly dying.
 *
 * So WebHID it is, and the local-service detour is not needed. What WebHID
 * cannot do is open a device without a user gesture and a permission prompt,
 * which is why connecting is a button rather than something that happens at
 * load.
 *
 * ── Reading the axes ─────────────────────────────────────────────────────
 *
 * From the device's own report descriptor, not from a table of byte offsets
 * per model. Every 3Dconnexion device lays its reports out slightly
 * differently — a Compact is not a SpacePilot, and firmware revisions move
 * things — and a guessed offset produces a camera that lurches in the wrong
 * axis on hardware nobody tested on. WebHID exposes the descriptor as
 * collections of input reports whose items declare their usages and field
 * widths, so the layout can be read from the declaration: Generic Desktop
 * X/Y/Z and RX/RY/RZ, wherever the device chose to put them, at whatever
 * width and range it chose to use.
 *
 * Walking the items in order to accumulate bit offsets is the HID spec's own
 * rule, not an assumption about these devices. What is still untested here is
 * only whether a real puck's descriptor matches the shape WebHID documents;
 * everything from that shape onwards is exercised against synthetic
 * descriptors in the unit tests.
 *
 * Translation and rotation usually arrive in separate reports, which is why
 * the latest value of each axis is held rather than a whole sample being
 * expected at once: a report carrying only rotation must not blank the
 * translation the previous one set.
 */

/* Generic Desktop usage page, and the six axes on it. WebHID reports a usage
   as `(page << 16) | usage`. */
const GD = 0x0001;
export const AXIS_USAGES = {
  [(GD << 16) | 0x30]: 'tx',
  [(GD << 16) | 0x31]: 'ty',
  [(GD << 16) | 0x32]: 'tz',
  [(GD << 16) | 0x33]: 'rx',
  [(GD << 16) | 0x34]: 'ry',
  [(GD << 16) | 0x35]: 'rz',
};

/* 3Dconnexion's vendor id. Used only to filter the device chooser, so the
   prompt does not list every keyboard on the machine. */
export const VENDOR_3DCONNEXION = 0x256f;
/* Logitech's, under which the older SpaceNavigators shipped. */
export const VENDOR_LOGITECH = 0x046d;

export function hidAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.hid;
}

/*
 * Where each axis lives, from the descriptor.
 *
 * Returns `{ [reportId]: [{ axis, bitOffset, bitSize, min, max }] }`. Items
 * that are not one of the six axes still advance the offset — a button array
 * or a padding field occupies its bits like anything else.
 */
export function axesFromCollections(collections) {
  const byReport = {};
  for (const collection of collections || []) {
    for (const report of collection.inputReports || []) {
      const id = report.reportId || 0;
      let bit = 0;
      for (const item of report.items || []) {
        const size = item.reportSize || 0;
        const count = item.reportCount || 0;
        const usages = item.usages || [];
        for (let i = 0; i < count; i++) {
          /* An item may declare fewer usages than it has fields, in which case
             the last one repeats — the HID spec's own rule for arrays. */
          const usage = usages.length ? usages[Math.min(i, usages.length - 1)] : null;
          const axis = usage != null ? AXIS_USAGES[usage] : null;
          if (axis) {
            (byReport[id] = byReport[id] || []).push({
              axis,
              bitOffset: bit,
              bitSize: size,
              min: item.logicalMinimum != null ? item.logicalMinimum : -(2 ** (size - 1)),
              max: item.logicalMaximum != null ? item.logicalMaximum : 2 ** (size - 1) - 1,
            });
          }
          bit += size;
        }
      }
    }
  }
  return byReport;
}

/*
 * A field of `bits` bits at `offset`, little-endian, signed when the
 * descriptor's logical minimum is negative.
 *
 * Bit-level rather than byte-level because the descriptor is allowed to put an
 * axis anywhere: most pucks use whole 16-bit little-endian fields, and reading
 * bit by bit costs nothing at six axes a report and removes the assumption.
 */
export function readField(view, offset, bits, signed) {
  let value = 0;
  for (let i = 0; i < bits; i++) {
    const at = offset + i;
    const byte = at >> 3;
    if (byte >= view.byteLength) break;
    const bit = (view.getUint8(byte) >> (at & 7)) & 1;
    value |= bit << i;
  }
  if (signed && bits > 0 && (value & (1 << (bits - 1)))) value -= 1 << bits;
  return value;
}

/*
 * Decode one report into the axes it carries, each normalised to −1…1.
 *
 * Only the axes present in this report are returned, so a caller can merge
 * without a rotation-only report blanking the translation.
 */
export function decodeReport(axes, reportId, view) {
  const fields = axes[reportId || 0];
  if (!fields) return null;
  const out = {};
  for (const f of fields) {
    const signed = f.min < 0;
    const raw = readField(view, f.bitOffset, f.bitSize, signed);
    /* Normalised by the wider half of the declared range, so a device with an
       asymmetric range still reports ±1 at its extremes without exceeding
       them in the narrow direction. */
    const scale = Math.max(Math.abs(f.min), Math.abs(f.max)) || 1;
    out[f.axis] = Math.max(-1, Math.min(1, raw / scale));
  }
  return out;
}

/*
 * A sample source over a WebHID device.
 *
 * `read()` returns the latest deflection of every axis, which is what a
 * rate-controlled camera wants: the puck is a spring, and the current push is
 * the whole state. Reports are merged into it as they arrive rather than
 * queued, so a slow frame drops stale samples instead of accumulating a
 * backlog that plays back as a lurch.
 *
 * `device` is a HIDDevice — already opened, or opened here. Injected rather
 * than fetched so a test can pass a fake one, which is the only way any of
 * this is exercisable without hardware.
 */
export function createHidSource(device) {
  const axes = axesFromCollections(device.collections);
  const latest = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  let sawAny = false;

  function onInputReport(event) {
    const decoded = decodeReport(axes, event.reportId, event.data);
    if (!decoded) return;
    Object.assign(latest, decoded);
    sawAny = true;
  }

  device.addEventListener('inputreport', onInputReport);

  return {
    /* Which axes the descriptor actually declared, so a caller can say
       "3 of 6 axes" rather than pretend to six. */
    get axisCount() {
      const found = new Set();
      for (const fields of Object.values(axes)) for (const f of fields) found.add(f.axis);
      return found.size;
    },
    /* Null until the device has said something, so the navigator loop does no
       work for a device that is connected but idle at the driver level. */
    read: () => (sawAny ? { ...latest } : null),
    close() {
      device.removeEventListener('inputreport', onInputReport);
      if (device.opened && device.close) return device.close();
      return undefined;
    },
  };
}

/*
 * Ask the user to pick a device, and open it.
 *
 * Must be called from a user gesture — WebHID requires one, and there is no
 * way around it, which is why this is behind a button. Returns null when the
 * API is missing or the user picked nothing, and throws only on a real
 * failure to open something they did choose.
 */
export async function requestSpaceMouse() {
  if (!hidAvailable()) return null;
  const devices = await navigator.hid.requestDevice({
    filters: [{ vendorId: VENDOR_3DCONNEXION }, { vendorId: VENDOR_LOGITECH }],
  });
  const device = devices && devices[0];
  if (!device) return null;
  if (!device.opened) await device.open();
  return device;
}

/*
 * A device the browser has already been granted, if any.
 *
 * Permission persists per origin, so a user who granted access once should not
 * have to click again on the next visit. Silent by design: no device, no
 * message, nothing on screen.
 */
export async function alreadyGrantedSpaceMouse() {
  if (!hidAvailable() || !navigator.hid.getDevices) return null;
  try {
    const devices = await navigator.hid.getDevices();
    const device = (devices || []).find((d) =>
      d.vendorId === VENDOR_3DCONNEXION || d.vendorId === VENDOR_LOGITECH);
    if (!device) return null;
    if (!device.opened) await device.open();
    return device;
  } catch {
    /* A device that is listed but cannot be opened — unplugged between the
       two calls, or claimed by another process. Not an error worth showing. */
    return null;
  }
}
