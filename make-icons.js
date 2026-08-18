const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  return Buffer.concat([u32(data.length), t, data, u32(crc32(Buffer.concat([t, data])))]);
}

// Create a simple rounded-square icon: amber background with a dark circle accent
function createIcon(size) {
  // Pixel data: draw amber (#E8B44A) background, darker center panel
  const rows = [];
  const cx = size / 2, cy = size / 2;
  const panelR = size * 0.30;
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter none
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const inPanel = (dx * dx + dy * dy) < panelR * panelR;
      if (inPanel) {
        // dark amber plate circle
        row.push(0xC0, 0x78, 0x18); // #C07818
      } else {
        // amber background
        row.push(0xE8, 0xB4, 0x4A); // #E8B44A
      }
    }
    rows.push(Buffer.from(row));
  }
  const raw = Buffer.concat(rows);
  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = chunk('IHDR', Buffer.concat([u32(size), u32(size), Buffer.from([8,2,0,0,0])]));
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

['192','512'].forEach(s => {
  const sz = parseInt(s);
  fs.writeFileSync(path.join(__dirname, 'public', `icon-${s}.png`), createIcon(sz));
  console.log(`Created icon-${s}.png`);
});
