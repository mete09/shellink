'use strict'
/**
 * 本地 SSH + SFTP 测试服务器（仅用于开发自测，不随应用发布）
 * 账号：demo / demo123   端口：2222
 */
const { Server, utils } = require('ssh2')
const pty = require('@lydell/node-pty')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')

const hostKey = utils.generateKeyPairSync('ed25519').private
const PORT = Number(process.env.PORT) || 2222

/* --------------------------------------------------- 虚拟文件系统沙箱 */

const SANDBOX = path.join(os.tmpdir(), 'shellpilot-sftp-demo')

function seedSandbox () {
  fs.mkdirSync(SANDBOX, { recursive: true })
  const files = {
    'readme.txt': 'ShellPilot SFTP 测试目录\n这里的内容由本地测试服务器提供。\n',
    'app.log': Array.from({ length: 40 }, (_, i) => `2026-11-01 20:${String(i).padStart(2, '0')}:00 INFO worker-${i % 4} heartbeat ok`).join('\n'),
    'package.json': '{\n  "name": "demo-app",\n  "version": "1.2.0"\n}\n'
  }
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(SANDBOX, name)
    if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8')
  }
  for (const dir of ['config', 'logs', 'scripts', path.join('logs', 'archive')]) {
    fs.mkdirSync(path.join(SANDBOX, dir), { recursive: true })
  }
  const cfg = path.join(SANDBOX, 'config', 'nginx.conf')
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, 'server {\n  listen 80;\n  root /var/www;\n}\n', 'utf8')
}

function toLocal (virtualPath) {
  const v = path.posix.normalize('/' + String(virtualPath || '/').replace(/^[/\\]+/, ''))
  const p = path.join(SANDBOX, v.replace(/^\/+/, ''))
  if (!p.startsWith(SANDBOX)) return null
  return p
}

const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 }

function attrsOf (stat) {
  return {
    mode: stat.mode,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000)
  }
}

function makeSftpHandler (stream) {
  const handles = new Map()
  let nextId = 1

  const idFor = (obj) => {
    const id = nextId++
    handles.set(id, obj)
    return Buffer.from(String(id))
  }
  const get = (buf) => handles.get(Number(buf.toString()))

  stream.on('REALPATH', (reqid, givenPath) => {
    const v = path.posix.normalize('/' + String(givenPath || '.').replace(/^[/\\]+/, ''))
    const resolved = v === '/' || v === '/.' ? '/' : v
    stream.name(reqid, [{
      filename: resolved,
      longname: resolved,
      attrs: attrsOf(fs.statSync(SANDBOX))
    }])
  })

  stream.on('STAT', (reqid, givenPath) => doStat(reqid, givenPath, true))
  stream.on('LSTAT', (reqid, givenPath) => doStat(reqid, givenPath, false))

  function doStat (reqid, givenPath, follow) {
    const local = toLocal(givenPath)
    if (!local) return stream.status(reqid, STATUS.PERMISSION_DENIED)
    try {
      const st = follow ? fs.statSync(local) : fs.lstatSync(local)
      stream.attrs(reqid, attrsOf(st))
    } catch (_) {
      stream.status(reqid, STATUS.NO_SUCH_FILE)
    }
  }

  stream.on('OPENDIR', (reqid, givenPath) => {
    const local = toLocal(givenPath)
    if (!local) return stream.status(reqid, STATUS.PERMISSION_DENIED)
    try {
      const entries = fs.readdirSync(local).map(name => {
        const full = path.join(local, name)
        let st
        try { st = fs.lstatSync(full) } catch (_) { return null }
        return {
          filename: name,
          longname: name,
          attrs: attrsOf(st)
        }
      }).filter(Boolean)
      stream.handle(reqid, idFor({ type: 'dir', entries, idx: 0 }))
    } catch (_) {
      stream.status(reqid, STATUS.NO_SUCH_FILE)
    }
  })

  stream.on('READDIR', (reqid, handleBuf) => {
    const h = get(handleBuf)
    if (!h || h.type !== 'dir') return stream.status(reqid, STATUS.FAILURE)
    if (h.idx >= h.entries.length) return stream.status(reqid, STATUS.EOF)
    const batch = h.entries.slice(h.idx, h.idx + 50)
    h.idx += batch.length
    stream.name(reqid, batch)
  })

  stream.on('OPEN', (reqid, filename, flags) => {
    const local = toLocal(filename)
    if (!local) return stream.status(reqid, STATUS.PERMISSION_DENIED)
    let mode = 'r'
    const wr = flags & 0x02
    const cre = flags & 0x08
    const trunc = flags & 0x10
    const append = flags & 0x04
    if (wr || cre) mode = append ? 'a' : trunc ? 'w' : 'r+'
    try {
      if (cre && !fs.existsSync(local)) fs.writeFileSync(local, '')
      const fd = fs.openSync(local, mode)
      stream.handle(reqid, idFor({ type: 'file', fd, path: local }))
    } catch (_) {
      stream.status(reqid, STATUS.NO_SUCH_FILE)
    }
  })

  stream.on('READ', (reqid, handleBuf, offset, length) => {
    const h = get(handleBuf)
    if (!h || h.type !== 'file') return stream.status(reqid, STATUS.FAILURE)
    try {
      const buf = Buffer.alloc(length)
      const n = fs.readSync(h.fd, buf, 0, length, offset)
      if (n === 0) return stream.status(reqid, STATUS.EOF)
      stream.data(reqid, n === length ? buf : buf.subarray(0, n))
    } catch (_) {
      stream.status(reqid, STATUS.FAILURE)
    }
  })

  stream.on('WRITE', (reqid, handleBuf, offset, data) => {
    const h = get(handleBuf)
    if (!h || h.type !== 'file') return stream.status(reqid, STATUS.FAILURE)
    try {
      fs.writeSync(h.fd, data, 0, data.length, offset)
      stream.status(reqid, STATUS.OK)
    } catch (_) {
      stream.status(reqid, STATUS.FAILURE)
    }
  })

  stream.on('FSTAT', (reqid, handleBuf) => {
    const h = get(handleBuf)
    if (!h) return stream.status(reqid, STATUS.FAILURE)
    try {
      stream.attrs(reqid, attrsOf(h.type === 'file' ? fs.fstatSync(h.fd) : fs.statSync(SANDBOX)))
    } catch (_) {
      stream.status(reqid, STATUS.FAILURE)
    }
  })

  stream.on('CLOSE', (reqid, handleBuf) => {
    const h = get(handleBuf)
    if (h && h.type === 'file') {
      try { fs.closeSync(h.fd) } catch (_) {}
    }
    handles.delete(Number(handleBuf.toString()))
    stream.status(reqid, STATUS.OK)
  })

  stream.on('MKDIR', (reqid, givenPath) => {
    const local = toLocal(givenPath)
    if (!local) return stream.status(reqid, STATUS.PERMISSION_DENIED)
    try {
      fs.mkdirSync(local, { recursive: true })
      stream.status(reqid, STATUS.OK)
    } catch (_) {
      stream.status(reqid, STATUS.FAILURE)
    }
  })

  stream.on('RMDIR', (reqid, givenPath) => {
    const local = toLocal(givenPath)
    if (!local) return stream.status(reqid, STATUS.PERMISSION_DENIED)
    try {
      fs.rmdirSync(local)
      stream.status(reqid, STATUS.OK)
    } catch (_) {
      stream.status(reqid, STATUS.FAILURE)
    }
  })

  stream.on('REMOVE', (reqid, givenPath) => {
    const local = toLocal(givenPath)
    if (!local) return stream.status(reqid, STATUS.PERMISSION_DENIED)
    try {
      fs.unlinkSync(local)
      stream.status(reqid, STATUS.OK)
    } catch (_) {
      stream.status(reqid, STATUS.FAILURE)
    }
  })

  stream.on('RENAME', (reqid, oldPath, newPath) => {
    const from = toLocal(oldPath)
    const to = toLocal(newPath)
    if (!from || !to) return stream.status(reqid, STATUS.PERMISSION_DENIED)
    try {
      fs.renameSync(from, to)
      stream.status(reqid, STATUS.OK)
    } catch (_) {
      stream.status(reqid, STATUS.FAILURE)
    }
  })

  stream.on('SETSTAT', (reqid) => stream.status(reqid, STATUS.OK))
}

/* ------------------------------------------------------------- 服务器 */

seedSandbox()

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('error', (e) => console.log('[test-ssh] client error:', e.message))
  client.on('close', () => {})

  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'demo' && ctx.password === 'demo123') {
      ctx.accept()
    } else {
      ctx.reject(['password'])
    }
  })

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      let proc = null
      let ptyInfo = { cols: 100, rows: 30 }

      session.on('pty', (acc, rej, info) => {
        ptyInfo = info
        acc && acc()
      })

      session.on('window-change', (acc, rej, info) => {
        if (proc) {
          try { proc.resize(info.cols, info.rows) } catch (_) {}
        }
        acc && acc()
      })

      session.on('shell', (acc) => {
        const stream = acc()
        proc = pty.spawn('C:\\Windows\\System32\\cmd.exe', [], {
          cols: ptyInfo.cols,
          rows: ptyInfo.rows,
          env: { ...process.env, TERM: 'xterm-256color' }
        })
        proc.onData(d => stream.write(d))
        stream.on('data', d => proc.write(d.toString('utf8')))
        stream.on('close', () => {
          try { proc.kill() } catch (_) {}
        })
        proc.onExit(() => {
          try {
            stream.exit(0)
            stream.end()
          } catch (_) {}
        })
      })

      session.on('sftp', (acc) => {
        const stream = acc()
        makeSftpHandler(stream)
      })
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[test-ssh] listening on 127.0.0.1:${PORT} (demo / demo123)`)
  console.log(`[test-sftp] sandbox: ${SANDBOX}`)
})
