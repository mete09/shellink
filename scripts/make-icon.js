'use strict'
/**
 * 用 logo.jpg 生成整套图标资源（不依赖图形库，PNG 由 zlib 手写编码）：
 *   build/icon.ico                 —— Windows 多尺寸图标（16~256，32bpp BMP 条目）
 *   build/icon.png                 —— 512px 透明 PNG
 *   src/renderer/assets/logo.png   —— 界面内使用的透明 PNG（256px）
 *
 * 用法：node scripts/make-icon.js
 * JPEG 解码与缩放借用 Electron 的 nativeImage（本文件会被自动交给 electron 执行）。
 */
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')

const electronModule = require('electron')
const inElectron = !!(electronModule && typeof electronModule === 'object' && electronModule.app)

if (!inElectron) {
  // 普通 node 下运行：自动以 electron 身份重跑自己
  const { spawnSync } = require('child_process')
  const r = spawnSync(electronModule, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  })
  process.exit(r.status || 0)
}

const { app, nativeImage } = electronModule

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'logo.jpg')
const OUT_ICO = path.join(ROOT, 'build', 'icon.ico')
const OUT_PNG = path.join(ROOT, 'build', 'icon.png')
const OUT_UI = path.join(ROOT, 'src', 'renderer', 'assets', 'logo.png')

const BASE = 512
/** 裁到圆角方块的边界，去掉四周留白与投影 */
const CROP = { x: 118, y: 104, width: 664, height: 664 }

/* --------------------------------------------------------------- 像素工具 */

function bgraToRgba (buf) {
  const out = Buffer.from(buf)
  for (let i = 0; i < out.length; i += 4) {
    const b = out[i]
    out[i] = out[i + 2]
    out[i + 2] = b
  }
  return out
}

/** 白底转透明：min 通道 ≥ 246 视为背景，236 以下为实体，中间羽化 */
function keyOutWhite (rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const min = Math.min(rgba[i], rgba[i + 1], rgba[i + 2])
    let a = Math.round(((246 - min) / 10) * 255)
    if (a > 255) a = 255
    if (a < 0) a = 0
    rgba[i + 3] = a
    if (a === 0) {
      rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255
    }
  }
  return rgba
}

/** 找出圆角方块的实际边界，去掉四周留白与投影 */
function detectBounds (rgba, size) {
  const isContent = (x, y) => {
    const o = (y * size + x) * 4
    return Math.min(rgba[o], rgba[o + 1], rgba[o + 2]) < 225
  }
  let left = size, right = 0, top = size, bottom = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isContent(x, y)) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right <= left || bottom <= top) return { x: 0, y: 0, width: size, height: size }
  const side = Math.max(right - left, bottom - top) + 1
  const cx = Math.round((left + right) / 2)
  const cy = Math.round((top + bottom) / 2)
  const x = Math.max(0, Math.min(size - side, cx - Math.round(side / 2)))
  const y = Math.max(0, Math.min(size - side, cy - Math.round(side / 2)))
  return { x, y, width: side, height: side }
}

/** 自检：四角应当是透明的 */
function cornerAlphas (rgba, size) {
  const pts = [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]
  return pts.map(([x, y]) => rgba[(y * size + x) * 4 + 3])
}

/** 按 alpha 加权的盒式缩放，避免透明边缘发白 */
function resize (rgba, srcSize, dstSize) {
  if (srcSize === dstSize) return Buffer.from(rgba)
  const out = Buffer.alloc(dstSize * dstSize * 4)
  const ratio = srcSize / dstSize
  for (let y = 0; y < dstSize; y++) {
    const y0 = Math.floor(y * ratio)
    const y1 = Math.min(srcSize, Math.ceil((y + 1) * ratio))
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * ratio)
      const x1 = Math.min(srcSize, Math.ceil((x + 1) * ratio))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * srcSize + sx) * 4
          const alpha = rgba[o + 3] / 255
          r += rgba[o] * alpha
          g += rgba[o + 1] * alpha
          b += rgba[o + 2] * alpha
          a += rgba[o + 3]
          n += alpha
        }
      }
      const d = (y * dstSize + x) * 4
      if (n > 0) {
        out[d] = Math.round(r / n)
        out[d + 1] = Math.round(g / n)
        out[d + 2] = Math.round(b / n)
      }
      const count = (y1 - y0) * (x1 - x0)
      out[d + 3] = Math.round(a / count)
    }
  }
  return out
}

/* ------------------------------------------------------------- PNG 编码 */

function crc32 (buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crc32.table[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng (rgba, size, height) {
  const h = height || size
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const raw = Buffer.alloc((size * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------- ICO 编码 */

/** 32bpp DIB 条目：BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码 */
function dibEntry (rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4, 20)

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2]
      xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]
      xor[d + 3] = rgba[s + 3]
    }
  }

  const maskRow = Math.ceil(size / 32) * 4
  const and = Buffer.alloc(maskRow * size)
  return Buffer.concat([header, xor, and])
}

function buildIco (rgba, sizes) {
  const entries = sizes.map(size => ({ size, data: dibEntry(resize(rgba, BASE, size), size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((e, i) => {
    const o = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(e.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.data.length
  })

  return Buffer.concat([header, dir, ...entries.map(e => e.data)])
}

/** 生成深色底预览图，用于肉眼检查小尺寸下的边缘 */
function preview (rgba) {
  const W = 420
  const H = 150
  const canvas = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    canvas[i * 4] = 12
    canvas[i * 4 + 1] = 12
    canvas[i * 4 + 2] = 12
    canvas[i * 4 + 3] = 255
  }
  const blit = (size, ox) => {
    const small = resize(rgba, BASE, size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4
        const a = small[s + 3] / 255
        if (a === 0) continue
        const d = ((y + 20) * W + x + ox) * 4
        for (let c = 0; c < 3; c++) {
          canvas[d + c] = Math.round(small[s + c] * a + canvas[d + c] * (1 - a))
        }
      }
    }
  }
  blit(16, 20)
  blit(32, 60)
  blit(48, 110)
  blit(96, 180)
  return encodePng(canvas, W, H)
}

function save (buf, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  console.log('  ✓', path.relative(ROOT, file), (buf.length / 1024).toFixed(1) + ' KB')
}

/* ---------------------------------------------------------------- 主流程 */

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(SRC)
  if (source.isEmpty()) {
    console.error('读取 logo.jpg 失败')
    app.exit(1)
    return
  }

  const full = bgraToRgba(source.toBitmap())
  const fullSize = source.getSize()
  const bounds = detectBounds(full, fullSize.width)
  console.log('[icon] 自动识别图形边界：', bounds)

  const scaled = source.crop(bounds).resize({ width: BASE, height: BASE, quality: 'best' })
  const rgba = keyOutWhite(bgraToRgba(scaled.toBitmap()))

  console.log('[icon] 生成图标：')
  console.log('  四角不透明度：', cornerAlphas(rgba, BASE).join(','))
  save(buildIco(rgba, [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]), OUT_ICO)
  save(encodePng(rgba, BASE), OUT_PNG)
  save(encodePng(resize(rgba, BASE, 256), 256), OUT_UI)
  if (process.env.SP_ICON_PREVIEW) save(preview(rgba), path.join(ROOT, 'build', 'icon-preview.png'))

  app.quit()
})
