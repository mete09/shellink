'use strict'
/**
 * SFTP 回归测试：列目录 / 下载 / 上传 / 建目录 / 重命名 / 删除
 * 运行前先启动 test/ssh-test-server.js
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SshSession } = require('../src/main/session')

const results = []
function check (name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

const session = new SshSession({
  id: 'sftp-test',
  profile: {
    type: 'ssh',
    host: '127.0.0.1',
    port: 2222,
    username: 'demo',
    authType: 'password',
    password: 'demo123',
    keepalive: 10,
    timeout: 10
  }
})

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sftp-'))

function waitConnected () {
  return new Promise((resolve, reject) => {
    session.on('status', (st) => {
      if (st.state === 'connected') resolve()
      if (st.state === 'error') reject(new Error(st.message))
    })
    session.start()
    setTimeout(() => reject(new Error('连接超时')), 12000)
  })
}

async function run () {
  await waitConnected()
  check('SSH 连接成功', true)

  const home = await session.home()
  check('获取家目录', home === '/', home)

  let listing = await session.list(home)
  const names = listing.items.map(i => i.name)
  check('列目录', names.includes('readme.txt') && names.includes('config'), names.join(','))
  check('目录排序（文件夹在前）', listing.items[0].isDir === true)

  const dl = await session.download('/readme.txt', tmpDir)
  const content = fs.readFileSync(dl, 'utf8')
  check('下载文件', content.includes('ShellPilot'), `${content.length} 字节`)

  const uploadSrc = path.join(tmpDir, 'upload-test.txt')
  fs.writeFileSync(uploadSrc, 'uploaded by ShellPilot test\n')
  const uploaded = await session.upload(uploadSrc, '/')
  check('上传文件', uploaded === '/upload-test.txt', uploaded)

  await session.mkdir('/sp-newdir')
  listing = await session.list('/')
  check('创建目录', listing.items.some(i => i.name === 'sp-newdir'))

  await session.rename('/sp-newdir', '/sp-renamed')
  listing = await session.list('/')
  check('重命名目录', listing.items.some(i => i.name === 'sp-renamed'))

  await session.remove('/sp-renamed', true)
  listing = await session.list('/')
  check('删除目录', !listing.items.some(i => i.name === 'sp-renamed'))

  await session.remove('/upload-test.txt', false)
  listing = await session.list('/')
  check('删除文件', !listing.items.some(i => i.name === 'upload-test.txt'))

  session.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}（共 ${results.length} 项）`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((e) => {
  check('测试执行', false, e.message)
  console.log(e.stack)
  process.exit(1)
})
