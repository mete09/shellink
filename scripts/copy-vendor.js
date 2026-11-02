'use strict'
/**
 * 把 xterm.js 及其插件的浏览器版（UMD）拷贝到 renderer/vendor，
 * 渲染进程直接用 <script> 加载，无需打包器。
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'src', 'renderer', 'vendor')

const targets = [
  { from: '@xterm/xterm/lib/xterm.js', to: 'xterm.js' },
  { from: '@xterm/xterm/css/xterm.css', to: 'xterm.css' },
  { from: '@xterm/addon-fit/lib/addon-fit.js', to: 'addon-fit.js' },
  { from: '@xterm/addon-web-links/lib/addon-web-links.js', to: 'addon-web-links.js' },
  { from: '@xterm/addon-search/lib/addon-search.js', to: 'addon-search.js' }
]

function findFallback (pkgDir, pattern) {
  try {
    const files = fs.readdirSync(pkgDir)
    return files.find(f => pattern.test(f)) || null
  } catch (_) {
    return null
  }
}

fs.mkdirSync(outDir, { recursive: true })

for (const t of targets) {
  const src = path.join(root, 'node_modules', t.from)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(outDir, t.to))
    continue
  }
  // 版本差异时按目录兜底查找
  const [scope, pkg, ...rest] = t.from.split('/')
  const pkgDir = path.join(root, 'node_modules', scope, pkg, rest[0] || 'lib')
  const found = findFallback(pkgDir, t.to.endsWith('.css') ? /\.css$/ : /\.js$/)
  if (found) {
    fs.copyFileSync(path.join(pkgDir, found), path.join(outDir, t.to))
  } else {
    console.warn('[vendor] 未找到', t.from)
  }
}

console.log('[vendor] xterm 资源已就绪 ->', path.relative(root, outDir))

/* ------------------------------------------------ shlnk 命令行入口（按版本生成） */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const tplPath = path.join(root, 'scripts', 'shlnk.cmd.tpl')
const cmdOut = path.join(root, 'build', 'shlnk.cmd')
if (fs.existsSync(tplPath)) {
  const content = fs.readFileSync(tplPath, 'utf8').replace(/__VERSION__/g, pkg.version)
  fs.mkdirSync(path.dirname(cmdOut), { recursive: true })
  fs.writeFileSync(cmdOut, content.replace(/\r?\n/g, '\r\n'), 'ascii')
  console.log('[vendor] shlnk 命令已生成 ->', path.relative(root, cmdOut), 'v' + pkg.version)
}
