import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const bytes = fs.readFileSync('package-lock.json');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const encoded = zlib.gzipSync(bytes, { level: 9 }).toString('base64');
const width = 2000;
for (let offset = 0, index = 0; offset < encoded.length; offset += width, index += 1) {
  const chunk = encoded.slice(offset, offset + width);
  process.stdout.write(`KNEEKURA_R4_LOCK_GZIP_B64_${String(index).padStart(3, '0')}=${chunk}\n`);
}
process.stdout.write(`KNEEKURA_R4_LOCK_GZIP_B64_CHUNKS=${Math.ceil(encoded.length / width)}\n`);
process.stdout.write(`KNEEKURA_R4_LOCK_SHA256=${digest}\n`);
process.stdout.write(`KNEEKURA_R4_LOCK_BYTES=${bytes.length}\n`);