const { app, nativeImage } = require('electron')
const fs = require('fs')

const file = process.argv[2]
const rects = JSON.parse(process.argv[3])
const scale = Number(process.argv[4] || 2)

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(file)
  console.log('size', img.getSize())
  rects.forEach((r, i) => {
    const c = img.crop(r)
    const out = c.resize({ width: Math.round(r.width * scale), height: Math.round(r.height * scale), quality: 'best' })
    const p = file.replace(/\.png$/, `-crop${i}.png`)
    fs.writeFileSync(p, out.toPNG())
    console.log('saved', p)
  })
  app.quit()
})
