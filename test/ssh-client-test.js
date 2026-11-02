'use strict'
/**
 * SSH 会话回归测试：连接 → 认证 → 打开 shell → 收发数据 → 调整窗口
 * 运行前先启动 test/ssh-test-server.js
 */
const { SshSession } = require('../src/main/session')

const results = []
function check (name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

const session = new SshSession({
  id: 'test-session',
  profile: {
    type: 'ssh',
    name: '本地测试机',
    host: '127.0.0.1',
    port: 2222,
    username: 'demo',
    authType: 'password',
    password: 'demo123',
    keepalive: 10,
    timeout: 10
  },
  cols: 100,
  rows: 30
})

let output = ''
let connected = false
let sawFingerprint = false
let exitSeen = false

session.on('status', (st) => {
  if (st.state === 'connected') {
    connected = true
    if (st.fingerprint && st.fingerprint.startsWith('SHA256:')) sawFingerprint = true
    // 输入命令验证双向数据通道
    setTimeout(() => {
      session.write('echo HELLO_SSH_TEST\r')
      session.resize(120, 40)
    }, 600)
  }
  if (st.state === 'error') {
    console.log('[status:error]', st.message)
  }
})

session.on('data', (chunk) => { output += chunk.toString('utf8') })
session.on('exit', () => { exitSeen = true })

session.start()

setTimeout(() => {
  check('建立连接并打开 shell', connected)
  check('上报主机密钥指纹', sawFingerprint)
  check('收到远端输出', output.length > 0, `${output.length} 字节`)
  check('命令回显正确', /HELLO_SSH_TEST/.test(output))
  session.close()
  setTimeout(() => {
    check('关闭会话后触发 exit', exitSeen)
    const failed = results.filter(r => !r.ok).length
    console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}（共 ${results.length} 项）`)
    process.exit(failed === 0 ? 0 : 1)
  }, 500)
}, 3200)
