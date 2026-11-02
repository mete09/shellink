'use strict'
/**
 * 会话层：本地 PTY 会话 与 SSH 会话（含 SFTP 文件操作）。
 * 设计参考 electerm (MIT) 的 session 分层思路，重新实现为更精简的单文件版本，
 * 补充了交互式认证提示、主机指纹上报、递归传输等能力。
 */
const { EventEmitter } = require('events')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const posix = path.posix
const crypto = require('crypto')
const { Client } = require('ssh2')

/* ------------------------------------------------------------------ 工具 */

function friendlyError (err) {
  const raw = (err && (err.message || err.level || String(err))) || '未知错误'
  const map = [
    [/ECONNREFUSED/i, '连接被拒绝：目标端口没有服务在监听'],
    [/ENOTFOUND|EAI_AGAIN/i, '无法解析主机地址，请检查主机名或网络'],
    [/ETIMEDOUT/i, '连接超时：目标主机不可达'],
    [/EHOSTUNREACH|ENETUNREACH/i, '网络不可达，请检查本机网络或 VPN'],
    [/Timed out while waiting for handshake/i, '握手超时：服务端未响应 SSH 协议'],
    [/All configured authentication methods failed/i, '认证失败：用户名、密码或密钥不正确'],
    [/Cannot parse privateKey|Unsupported key format/i, '私钥格式无法解析'],
    [/Encrypted private OpenSSH key detected.*no passphrase/i, '私钥已加密，请填写私钥口令'],
    [/no matching (C->S|S->C)/i, '与服务端的加密算法不匹配'],
    [/Host key verification failed/i, '主机密钥校验失败'],
    [/read ECONNRESET/i, '连接被重置（服务端主动断开）']
  ]
  for (const [re, msg] of map) {
    if (re.test(raw)) return msg
  }
  return raw
}

function expandHome (p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function toPosixPath (p) {
  return p.replace(/\\/g, '/')
}

function humanSize (n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Number(n) || 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/* ------------------------------------------------------------- 本地终端 */

class LocalSession extends EventEmitter {
  constructor ({ id, profile, cols = 100, rows = 30 }) {
    super()
    this.id = id
    this.kind = 'local'
    this.profile = profile
    this.closed = false
    this.proc = null
    this.shellInfo = { cols, rows }
  }

  start () {
    const pty = require('@lydell/node-pty')
    const { shell, args = [], name } = this.profile.local || {}
    const cwd = expandHome(this.profile.cwd) || os.homedir()
    this.emit('status', { state: 'connecting', message: `正在启动 ${name || shell}` })
    try {
      this.proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: this.shellInfo.cols,
        rows: this.shellInfo.rows,
        cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: process.env.LANG || 'zh_CN.UTF-8'
        }
      })
    } catch (e) {
      this.emit('status', { state: 'error', message: friendlyError(e) })
      this.emit('exit', { code: -1 })
      return
    }

    this.proc.onData(data => {
      if (!this.closed) this.emit('data', Buffer.from(data, 'utf8'))
    })
    this.proc.onExit(({ exitCode }) => {
      if (this.closed) return
      this.closed = true
      this.emit('status', { state: 'closed', message: '会话已结束' })
      this.emit('exit', { code: exitCode })
    })
    this.emit('status', { state: 'connected', message: '本地终端已就绪' })
  }

  write (data) {
    try { this.proc && this.proc.write(data) } catch (_) {}
  }

  resize (cols, rows) {
    this.shellInfo = { cols, rows }
    try { this.proc && this.proc.resize(cols, rows) } catch (_) {}
  }

  close () {
    this.closed = true
    try { this.proc && this.proc.kill() } catch (_) {}
    this.emit('exit', { code: 0 })
  }
}

/* ------------------------------------------------------------------ SSH */

class SshSession extends EventEmitter {
  constructor ({ id, profile, cols = 100, rows = 30 }) {
    super()
    this.id = id
    this.kind = 'ssh'
    this.profile = profile
    this.closed = false
    this.client = null
    this.stream = null
    this.sftp = null
    this.pendingPrompt = null
    this.size = { cols, rows }
    this.remoteCwd = null
    this.fingerprint = ''
  }

  buildConfig () {
    const p = this.profile
    const cfg = {
      host: (p.host || '').trim(),
      port: Number(p.port) || 22,
      username: (p.username || '').trim() || undefined,
      readyTimeout: (Number(p.timeout) || 20) * 1000,
      keepaliveInterval: Number(p.keepalive) > 0 ? Number(p.keepalive) * 1000 : 0,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key) => {
        try {
          const hash = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
          this.fingerprint = 'SHA256:' + hash
          this.emit('status', { state: 'connecting', message: '正在认证…', fingerprint: this.fingerprint })
        } catch (_) {}
        return true
      }
    }

    if (process.env.SSH_DEBUG) cfg.debug = (msg) => console.log('[ssh2]', msg)

    const auth = p.authType || 'password'
    if (auth === 'password') {
      cfg.password = p.password || ''
    } else if (auth === 'key') {
      let key = p.privateKey || ''
      if (!key && p.privateKeyPath) {
        try {
          key = fs.readFileSync(expandHome(p.privateKeyPath), 'utf8')
        } catch (e) {
          throw new Error(`无法读取私钥文件：${p.privateKeyPath}`)
        }
      }
      if (!key) throw new Error('未提供私钥内容或私钥文件路径')
      cfg.privateKey = key
      if (p.privateKeyPass) cfg.passphrase = p.privateKeyPass
    } else if (auth === 'agent') {
      cfg.agent = process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent'
      if (p.password) cfg.password = p.password
    }

    return cfg
  }

  /** 由 main 在事件桥接完成后调用，避免早期事件丢失 */
  start () {
    this.emit('status', {
      state: 'connecting',
      message: `正在连接 ${this.profile.host}:${this.profile.port || 22}`
    })
    this.connect()
  }

  async connect () {
    // 快速连接 / 命令行 / 未保存密码的连接：先向界面要一次密码
    const p = this.profile
    if ((p.authType || 'password') === 'password' && !p.password && !this._passwordAsked && this.listenerCount('prompt') > 0) {
      this._passwordAsked = true
      const pw = await this.ask('password', `请输入 ${p.username ? p.username + '@' : ''}${p.host} 的密码`, false)
      if (!pw) {
        this.emit('status', { state: 'error', message: '已取消连接：未输入密码' })
        this.emit('exit', { code: -1 })
        return
      }
      p.password = pw
    }

    let cfg
    try {
      cfg = this.buildConfig()
    } catch (e) {
      this.emit('status', { state: 'error', message: friendlyError(e) })
      this.emit('exit', { code: -1 })
      return
    }

    const client = new Client()
    this.client = client

    client.on('keyboard-interactive', async (name, instructions, lang, prompts, finish) => {
      try {
        const answers = []
        for (const item of prompts) {
          const value = await this.ask('otp', item.prompt || '请输入验证码：', item.echo !== false)
          answers.push(value || '')
        }
        finish(answers)
      } catch (_) {
        finish([])
      }
    })

    client.on('error', (err) => {
      if (this.closed) return
      this.emit('status', { state: 'error', message: friendlyError(err) })
    })

    client.on('close', () => {
      if (this.closed) return
      this.closed = true
      this.emit('status', { state: 'closed', message: '连接已断开' })
      this.emit('exit', { code: 0 })
    })

    client.on('end', () => {
      if (this.closed) return
      this.closed = true
      this.emit('status', { state: 'closed', message: '连接已结束' })
      this.emit('exit', { code: 0 })
    })

    client.on('ready', () => this.openShell())

    client.connect(cfg)
  }

  openShell () {
    this.client.shell({
      term: 'xterm-256color',
      cols: this.size.cols,
      rows: this.size.rows
    }, (err, stream) => {
      if (err) {
        this.emit('status', { state: 'error', message: friendlyError(err) })
        this.close()
        return
      }
      this.stream = stream
      this.emit('status', { state: 'connected', message: `已连接 ${this.profile.username || 'root'}@${this.profile.host}`, fingerprint: this.fingerprint })

      stream.on('data', (chunk) => {
        if (!this.closed) this.emit('data', chunk)
      })
      stream.stderr.on('data', (chunk) => {
        if (!this.closed) this.emit('data', chunk)
      })
      stream.on('close', () => {
        if (this.closed) return
        this.closed = true
        this.emit('status', { state: 'closed', message: '会话已关闭' })
        this.emit('exit', { code: 0 })
        try { this.client.end() } catch (_) {}
      })

      const init = (this.profile.initCommand || '').trim()
      if (init) {
        setTimeout(() => {
          if (!this.closed) this.write(init + '\r')
        }, 700)
      }
    })
  }

  write (data) {
    try {
      if (this.stream && !this.closed) this.stream.write(data)
    } catch (_) {}
  }

  resize (cols, rows) {
    this.size = { cols, rows }
    try {
      if (this.stream && !this.closed) this.stream.setWindow(rows, cols, 0, 0)
    } catch (_) {}
  }

  ask (kind, prompt, echo = true) {
    // 探测连接等场景没有 UI 监听，直接使用已保存口令，避免无限等待
    if (this.listenerCount('prompt') === 0) return Promise.resolve(this.profile.password || '')
    return new Promise((resolve) => {
      this.pendingPrompt = resolve
      this.emit('prompt', { kind, prompt, echo })
    })
  }

  answerPrompt (value) {
    const resolve = this.pendingPrompt
    this.pendingPrompt = null
    this.emit('prompt-cancel', {})
    if (resolve) resolve(value)
  }

  close () {
    this.closed = true
    try { this.stream && this.stream.end() } catch (_) {}
    try { this.client && this.client.end() } catch (_) {}
    this.emit('exit', { code: 0 })
  }

  /* --------------------------------------------------------------- SFTP */

  ensureSftp () {
    if (this.sftp) return Promise.resolve(this.sftp)
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('SSH 尚未连接'))
      this.client.sftp((err, sftp) => {
        if (err) return reject(new Error(friendlyError(err)))
        this.sftp = sftp
        sftp.on('close', () => { this.sftp = null })
        resolve(sftp)
      })
    })
  }

  async list (remotePath) {
    const sftp = await this.ensureSftp()
    const dir = posix.resolve(this.remoteCwd || '/', toPosixPath(remotePath || '.'))
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, list) => (err ? reject(new Error(friendlyError(err))) : resolve(list)))
    })
    const items = entries.map(e => ({
      name: e.filename,
      path: posix.join(dir, e.filename),
      isDir: e.attrs.isDirectory(),
      isLink: e.attrs.isSymbolicLink(),
      size: e.attrs.size,
      sizeText: e.attrs.isDirectory() ? '' : humanSize(e.attrs.size),
      mtime: e.attrs.mtime * 1000,
      mode: e.attrs.mode
    })).filter(e => e.name !== '.' && e.name !== '..')

    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return { path: dir, parent: dir === '/' ? '/' : posix.dirname(dir), items }
  }

  async home () {
    const sftp = await this.ensureSftp()
    const p = await new Promise((resolve, reject) => {
      sftp.realpath('.', (err, abs) => (err ? reject(new Error(friendlyError(err))) : resolve(abs)))
    })
    this.remoteCwd = p
    return p
  }

  async mkdir (remotePath) {
    const sftp = await this.ensureSftp()
    await new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, err => (err ? reject(new Error(friendlyError(err))) : resolve()))
    })
  }

  async rename (from, to) {
    const sftp = await this.ensureSftp()
    await new Promise((resolve, reject) => {
      sftp.rename(from, to, err => (err ? reject(new Error(friendlyError(err))) : resolve()))
    })
  }

  async remove (remotePath, isDir) {
    const sftp = await this.ensureSftp()
    await new Promise((resolve, reject) => {
      const cb = err => (err ? reject(new Error(friendlyError(err))) : resolve())
      if (isDir) sftp.rmdir(remotePath, cb)
      else sftp.unlink(remotePath, cb)
    })
  }

  async stat (remotePath) {
    const sftp = await this.ensureSftp()
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, st) => (err ? reject(new Error(friendlyError(err))) : resolve(st)))
    })
  }

  async download (remotePath, localDir) {
    const sftp = await this.ensureSftp()
    const st = await this.stat(remotePath)
    const base = posix.basename(remotePath)
    const target = path.join(localDir, base)
    if (st.isDirectory()) {
      await fsp.mkdir(target, { recursive: true })
      const { items } = await this.list(remotePath)
      for (const item of items) {
        await this.download(item.path, target)
      }
      return target
    }
    await this.copyRemoteToLocal(sftp, remotePath, target, st.size)
    return target
  }

  copyRemoteToLocal (sftp, remote, local, total) {
    return new Promise((resolve, reject) => {
      let last = 0
      sftp.fastGet(remote, local, {
        step: (transferred) => {
          const now = Date.now()
          if (now - last > 120) {
            last = now
            this.emit('progress', { op: 'download', file: posix.basename(remote), transferred, total })
          }
        }
      }, err => (err ? reject(new Error(friendlyError(err))) : resolve()))
    })
  }

  async upload (localPath, remoteDir) {
    const sftp = await this.ensureSftp()
    const st = await fsp.stat(localPath)
    const base = path.basename(localPath)
    const target = posix.join(toPosixPath(remoteDir), base)
    if (st.isDirectory()) {
      try { await this.mkdir(target) } catch (_) {}
      const children = await fsp.readdir(localPath)
      for (const child of children) {
        await this.upload(path.join(localPath, child), target)
      }
      return target
    }
    await new Promise((resolve, reject) => {
      let last = 0
      sftp.fastPut(localPath, target, {
        step: (transferred, chunk, total) => {
          const now = Date.now()
          if (now - last > 120) {
            last = now
            this.emit('progress', { op: 'upload', file: base, transferred, total })
          }
        }
      }, err => (err ? reject(new Error(friendlyError(err))) : resolve()))
    })
    return target
  }
}

/* --------------------------------------------------------------- 工厂 */

function createSession (opts) {
  if (opts.profile.type === 'local') return new LocalSession(opts)
  return new SshSession(opts)
}

module.exports = { createSession, LocalSession, SshSession, friendlyError, humanSize }
