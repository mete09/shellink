// build/after-pack.js
// 打包后裁剪：去掉本项目用不到的 Electron 组件，把安装包压到 100 MB 以内。
//
// 只删除两个二进制：
//   dxcompiler.dll     —— D3D12 / WebGPU(Dawn) 的 HLSL 编译器，Chromium 按需加载
//   vk_swiftshader.dll —— Vulkan 的软件后备实现，只服务 WebGPU
// Shellink 的终端界面走 ANGLE + D3D11（依赖的是 d3dcompiler_47.dll，保留），
// 不使用 WebGPU，因此这两个文件在整个生命周期里都不会被加载。
const fs = require('fs')
const path = require('path')

const REMOVE = ['dxcompiler.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json']

module.exports = async function afterPack(context) {
  const dir = context.appOutDir
  let saved = 0

  for (const name of REMOVE) {
    const file = path.join(dir, name)
    try {
      const size = fs.statSync(file).size
      fs.rmSync(file, { force: true })
      saved += size
      console.log(`  • trimmed ${name} (${(size / 1048576).toFixed(1)} MB)`)
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`  • trim skipped ${name}: ${err.message}`)
    }
  }

  if (saved > 0) console.log(`  • trimmed total ${(saved / 1048576).toFixed(1)} MB`)
}
