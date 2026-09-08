/*
 * A ZIP writer, in about a hundred lines.
 *
 * Written out rather than pulled in for the same reason build.js has no
 * dependencies: the deliverable is one HTML file someone double-clicks, and
 * every library it does not need is a library that cannot break it. The format
 * used here is the 1989 original — local header, data, central directory, end
 * record — with none of the extensions, which is what every unzip on earth
 * reads.
 *
 * Compression is `CompressionStream('deflate-raw')`, which is exactly the
 * bitstream ZIP method 8 wants, so the browser does the work and this file
 * does the bookkeeping. Where it is unavailable the entry is stored
 * uncompressed instead — a larger archive rather than no archive, and the
 * difference matters: a STEP file is mostly repeated ASCII and deflates to
 * something like a seventh of its size, which is the difference between an
 * attachment that sends and one that bounces.
 *
 * Not supported, deliberately: Zip64. An archive over 4 GB, or a member over
 * it, needs a different central directory, and this is assembling a report and
 * a CAD file. The limit is checked rather than overflowed silently.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/* The point past which the fields below stop being able to describe the
   archive. Reached only by something that should not be in one. */
const ZIP_LIMIT = 0xffffffff;

/*
 * CRC-32, IEEE 802.3 polynomial, over the *uncompressed* bytes — which is
 * what ZIP stores, and also what makes it useful to report in the manifest: a
 * recipient can check the file they extracted is the file that was measured.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* Eight hex digits, which is how a CRC is quoted and compared. */
export function crc32Hex(bytes) {
  return crc32(bytes).toString(16).padStart(8, '0');
}

/*
 * MS-DOS date and time, which is what the header fields are.
 *
 * Two-second resolution and a 1980 epoch, and local time with no zone — the
 * format has no way to record one. Written from the local clock because that
 * is what every other tool writes and what a recipient's unzip will show.
 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    /* An engine that has the constructor but not this format. Storing is
       always available, so there is nothing here worth failing over. */
    return null;
  }
}

/* Little-endian writer over a growable list of chunks. */
function record(fields) {
  let size = 0;
  for (const [width] of fields) size += width;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [width, value] of fields) {
    if (width === 2) view.setUint16(at, value, true);
    else if (width === 4) view.setUint32(at, value, true);
    else out.set(value, at);
    at += width;
  }
  return out;
}

/*
 * Build a ZIP from `[{ name, bytes }]`.
 *
 * Names are used verbatim, so a caller passing "a/b.txt" gets a directory.
 * Returns a Blob, and the per-entry sizes and CRCs, since the manifest inside
 * the archive wants to quote them and computing them twice invites the two
 * copies disagreeing.
 */
export async function createZip(entries, now = new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);

  const chunks = [];
  const central = [];
  const summary = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
    const crc = crc32(raw);

    const deflated = await deflateRaw(raw);
    /* Deflate can enlarge already-compressed data — a PDF, a PNG — in which
       case storing it is both smaller and faster to read. */
    const useDeflate = deflated != null && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    if (raw.length > ZIP_LIMIT || payload.length > ZIP_LIMIT) {
      throw new Error(`${entry.name} is too large for a ZIP without Zip64 support`);
    }

    const local = record([
      [4, LOCAL_SIG],
      [2, 20],            // version needed: 2.0, which is deflate
      [2, 0],             // flags: none. No data descriptor, no UTF-8 bit.
      [2, method],
      [2, time], [2, date],
      [4, crc],
      [4, payload.length], [4, raw.length],
      [2, name.length], [2, 0],
      [name.length, name],
    ]);
    chunks.push(local, payload);

    central.push(record([
      [4, CENTRAL_SIG],
      [2, 20], [2, 20],
      [2, 0],
      [2, method],
      [2, time], [2, date],
      [4, crc],
      [4, payload.length], [4, raw.length],
      [2, name.length], [2, 0], [2, 0],
      [2, 0],             // disk number
      [2, 0],             // internal attributes
      [4, 0],             // external attributes
      [4, offset],
      [name.length, name],
    ]));

    summary.push({ name: entry.name, bytes: raw.length, stored: payload.length, crc32: crc32Hex(raw), deflated: useDeflate });
    offset += local.length + payload.length;
  }

  const dirBytes = central.reduce((n, c) => n + c.length, 0);
  if (offset > ZIP_LIMIT || dirBytes > ZIP_LIMIT) {
    throw new Error('archive is too large for a ZIP without Zip64 support');
  }

  const end = record([
    [4, END_SIG],
    [2, 0], [2, 0],
    [2, entries.length], [2, entries.length],
    [4, dirBytes],
    [4, offset],
    [2, 0],             // no archive comment
  ]);

  return { blob: new Blob([...chunks, ...central, end], { type: 'application/zip' }), entries: summary };
}
