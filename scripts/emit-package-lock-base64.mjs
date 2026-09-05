import fs from 'node:fs';

const bytes = fs.readFileSync('package-lock.json');
const encoded = bytes.toString('base64');
const width = 3000;
for (let offset = 0, index = 0; offset < encoded.length; offset += width, index += 1) {
  const chunk = encoded.slice(offset, offset + width);
  process.stdout.write(`KNEEKURA_R4_LOCK_B64_${String(index).padStart(3, '0')}=${chunk}\n`);
}
process.stdout.write(`KNEEKURA_R4_LOCK_B64_CHUNKS=${Math.ceil(encoded.length / width)}\n`);