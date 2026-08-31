const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01
const ZIP32_MAX = 0xffffffff;

export function createDeterministicZip(entries, { root = 'kneekura-human-guide' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('zip entries must be a non-empty array');
  if (entries.length > 0xffff) throw new TypeError('zip entry count exceeds ZIP32 limit');
  const safeRoot = normalizeZipPath(root, { allowEmpty: true });
  const normalized = entries.map(entry => normalizeEntry(entry, safeRoot));
  normalized.sort((a, b) => compareText(a.path, b.path));
  const seen = new Set();
  for (const entry of normalized) {
    if (seen.has(entry.path)) throw new TypeError(`duplicate zip entry: ${entry.path}`);
    seen.add(entry.path);
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of normalized) {
    const name = Buffer.from(entry.path, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? Buffer.from(entry.data) : Buffer.from(String(entry.data ?? ''), 'utf8');
    if (name.length > 0xffff) throw new TypeError(`zip entry name exceeds ZIP32 limit: ${entry.path}`);
    if (data.length > ZIP32_MAX) throw new TypeError(`zip entry data exceeds ZIP32 limit: ${entry.path}`);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(STORE_METHOD, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(STORE_METHOD, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
    if (offset > ZIP32_MAX) throw new TypeError('zip local data exceeds ZIP32 limit');
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > ZIP32_MAX) throw new TypeError('zip central directory exceeds ZIP32 limit');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(normalized.length, 8);
  eocd.writeUInt16LE(normalized.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function normalizeEntry(entry, root) {
  if (!entry || typeof entry !== 'object') throw new TypeError('zip entry must be an object');
  const relative = normalizeZipPath(entry.path);
  const entryPath = root ? `${root}/${relative}` : relative;
  return { path: entryPath, data: Buffer.isBuffer(entry.data) ? Buffer.from(entry.data) : String(entry.data ?? '') };
}

function normalizeZipPath(value, { allowEmpty = false } = {}) {
  const text = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (allowEmpty && text === '') return '';
  if (!text || text.startsWith('/') || /^[A-Za-z]:\//.test(text) || text.split('/').some(part => part === '..' || part === '')) {
    throw new TypeError(`unsafe zip path: ${value}`);
  }
  return text;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
