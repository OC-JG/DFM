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
 *
 * ── Cross-checked against implementations that have run on real pucks ────
 *
 * No device was attached to any of this, so the assumptions above were checked
 * against projects that have been run against real hardware — pyspacenavigator
 * (per-model byte layouts for eight devices) and spacenavd (the Linux daemon).
 * Read as documentation of the protocol, not copied. Four things came back.
 *
 * *The vendor filter is complete.* All eight devices in the reference — from
 * the SpaceNavigator to the Universal Receiver — sit under Logitech's id or
 * 3Dconnexion's, which is what `requestSpaceMouse` already filters on. The
 * Linux kernel knows the same two.
 *
 * *There are two report layouts, and both work here.* The SpaceNavigator and
 * SpaceMouse Compact put translation in report 1 and rotation in report 2;
 * the Pro, the Wireless and the Universal Receiver put all six axes in
 * report 1. Holding the latest value per axis covers both, and both are now
 * fixtures in the unit tests — the single-report shape was the untested one,
 * and it is the layout of every current device.
 *
 * *The range fallback was wrong in both directions.* See
 * `DEFAULT_AXIS_FULL_SCALE` and `axisRange`. Found by asking what this code
 * does with a descriptor that declares nothing, which is a question the
 * synthetic fixtures never posed because they all declared ±350.
 *
 * *Axis directions are still a hardware question, and the reference says to
 * expect them to need flipping.* pyspacenavigator negates four of the six
 * axes — Y, Z, pitch and roll — and leaves X and yaw alone, to reach a
 * conventional screen frame. This file deliberately applies no sign
 * correction: it reports what the descriptor's axes say, and `navigator.js`
 * maps them onto the camera. So the thing to check with a puck in hand is
 * whether pushing away from you flies the camera forward or backward, per
 * axis, and the likely correction is a sign flip in that mapping rather than
 * anything here. Four of six is a specific enough prediction to be worth
 * writing down before the session rather than rediscovering during it.
 *
 * One failure mode the reference cannot rule out: a device that declares a
 * range far wider than it actually swings would normalise to a fraction of
 * full scale and feel dead, and the honest response is a per-device override
 * rather than second-guessing every descriptor here. If a real puck reads
 * dead with a range declared, that is what it is, and it belongs in the same
 * session as the direction check.
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

/*
 * Full-scale deflection to assume when the descriptor will not say.
 *
 * Only a fallback: a descriptor that declares a usable range is believed,
 * because believing the device is the whole point of reading the descriptor.
 * It matters because the previous fallback was the width of the field itself,
 * and that is not a neutral choice — see `axisRange` below for what it did.
 *
 * 350 rather than a round number: every 3Dconnexion device in the
 * cross-checked reference implementations uses ±350, from the 2007
 * SpaceNavigator through the current wireless pucks. It is a house constant
 * of the vendor's, not a per-model figure, which is what makes it a
 * defensible thing to fall back to.
 */
export const DEFAULT_AXIS_FULL_SCALE = 350;

/*
 * The usable signed range of one axis item, from the descriptor or from the
 * fallback above.
 *
 * The rule is spacenavd's: seed a sane default, then let the device's own
 * declaration override it — rather than deriving a range from the field width,
 * which is what this used to do and which fails in two directions.
 *
 * A 16-bit field with no declared bounds became ±32768, so a device swinging
 * its full ±350 normalised to 0.011 — inside the navigator's 0.08 dead zone,
 * making a connected, reporting puck that never moves the camera. And bounds
 * declared as 0/0 collapsed the scale to 1, so a single count saturated the
 * axis and the camera slammed to full rate on a touch. Neither is a plausible
 * reading of a device that declared nothing useful; both were reachable from a
 * descriptor this code would otherwise have accepted without comment.
 *
 * `min < max` is the test rather than `!= null`, because 0/0 is what an
 * item that never set its bounds looks like once WebHID has filled the gaps.
 */
export function axisRange(item) {
  const min = item.logicalMinimum;
  const max = item.logicalMaximum;
  if (min != null && max != null && min < max) return { min, max };
  return { min: -DEFAULT_AXIS_FULL_SCALE, max: DEFAULT_AXIS_FULL_SCALE };
}

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
            const { min, max } = axisRange(item);
            (byReport[id] = byReport[id] || []).push({
              axis, bitOffset: bit, bitSize: size, min, max,
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
