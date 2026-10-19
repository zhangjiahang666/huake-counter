/* 生成划课站点图标 PNG（favicon-32.png / apple-touch-icon.png / PWA 图标）
   与 favicon.svg 同一套设计：品牌蓝圆角底 + 白色笔记本 + 红色书签/划掉线。
   opts.pad > 0 时生成 maskable 变体：设计缩小居中，露出的底用品牌纯色铺满。
   纯 Node 手写 PNG 编码（zlib 内置），无第三方依赖。
   用法：node scripts/gen_favicon.js */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

/* ---------- 基础几何 ---------- */
function inRoundRect(x, y, rx, ry, w, h, r) {
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inRect(x, y, rx, ry, w, h) {
  return x >= rx && x <= rx + w && y >= ry && y <= ry + h;
}
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ---------- 上色：按 SVG 设计逐层判断（64×64 设计空间） ---------- */
function shade(x, y) {
  if (!inRoundRect(x, y, 0, 0, 64, 64, 14)) return null;                 // 圆角底
  const t = y / 64;                                                        // 竖向渐变
  const bg = [Math.round(111 + (79 - 111) * t), Math.round(147 + (124 - 147) * t), Math.round(255 + (255 - 255) * t)];
  if (!inRoundRect(x, y, 20, 13, 24, 38, 3)) return bg;                    // 笔记本外形
  if (inRect(x, y, 20, 14, 6.5, 36)) return [230, 236, 255];               // 书脊
  if (inCircle(x, y, 23.2, 21, 1.5) || inCircle(x, y, 23.2, 32, 1.5) || inCircle(x, y, 23.2, 43, 1.5)) return [79, 124, 255]; // 装订环
  if (inRoundRect(x, y, 30.5, 21, 10, 2.4, 1.2) ||
      inRoundRect(x, y, 30.5, 27.5, 10, 2.4, 1.2)) return [195, 210, 251]; // 课时行
  // 红色划掉线（绕中心旋转 -8°）：把点绕中心转 +8° 再测未旋转矩形
  const sx = x - 33.75, sy = y - 35.2, a = 8 * Math.PI / 180;
  const rx2 = sx * Math.cos(a) - sy * Math.sin(a) + 33.75;
  const ry2 = sx * Math.sin(a) + sy * Math.cos(a) + 35.2;
  if (inRoundRect(rx2, ry2, 30.5, 34, 6.5, 2.4, 1.2)) return [229, 72, 77];
  if (inPoly(x, y, [[39.5, 13], [45.5, 13], [45.5, 24.5], [42.5, 21.5], [39.5, 24.5]])) return [229, 72, 77]; // 书签带
  return [255, 255, 255];
}

function renderPNG(size, outFile, opts) {
  opts = opts || {};
  const pad = opts.pad || 0;                 // maskable：四周留白比例
  const s = 1 - pad * 2;                     // 设计缩放
  const flat = [95, 124, 255];               // 露出的底的品牌纯色
  const px = Buffer.alloc(size * size * 4);
  const S = 3; // 3×3 超采样抗锯齿
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          // 设计空间坐标（64×64），pad 时先归一化再缩放回中心
          const nx = (pxi + (sx + 0.5) / S) / size;
          const ny = (py + (sy + 0.5) / S) / size;
          const x = (nx - 0.5) * 64 / s + 32;
          const y = (ny - 0.5) * 64 / s + 32;
          const c = shade(x, y);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
          else if (pad > 0) { r += flat[0]; g += flat[1]; b += flat[2]; a += 255; }
        }
      }
      const n = S * S;
      const i = (py * size + pxi) * 4;
      px[i] = Math.round(r / n); px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n); px[i + 3] = Math.round(a / n);
    }
  }
  // PNG 编码
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(outFile, png);
  console.log('written', outFile, png.length + ' bytes');
}

renderPNG(32, path.join(ROOT, 'favicon-32.png'));
renderPNG(180, path.join(ROOT, 'apple-touch-icon.png'));
renderPNG(192, path.join(ROOT, 'icon-192.png'));
renderPNG(512, path.join(ROOT, 'icon-512.png'));
renderPNG(512, path.join(ROOT, 'icon-maskable-512.png'), { pad: 0.2 });
