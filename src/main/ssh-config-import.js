'use strict'
/**
 * 从 ~/.ssh/config 导入主机（支持 HostName / User / Port / IdentityFile / 通配默认值）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

function stripComment (line) {
  let inQuote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === inQuote) inQuote = null
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function parse (text) {
  const blocks = []
  let current = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    const m = line.match(/^([A-Za-z][\w-]*)\s*(?:=\s*|\s+)(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      if (current) blocks.push(current)
      current = { hosts: value.split(/\s+/).filter(Boolean), opts: {} }
    } else if (key === 'match') {
      if (current) blocks.push(current)
      current = null
    } else if (current) {
      if (!(key in current.opts)) current.opts[key] = value
    }
  }
  if (current) blocks.push(current)
  return blocks
}

function expandPath (p) {
  if (!p) return ''
  let v = p.replace(/^"|"$/g, '')
  if (v === '~') return os.homedir()
  if (v.startsWith('~/')) v = path.join(os.homedir(), v.slice(2))
  return v
}

function importSshConfig () {
  const file = path.join(os.homedir(), '.ssh', 'config')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (_) {
    return []
  }

  const blocks = parse(text)

  // Host * 作为全局默认值
  const defaults = {}
  for (const b of blocks) {
    if (b.hosts.includes('*') || b.hosts.includes('global')) {
      for (const [k, v] of Object.entries(b.opts)) {
        if (!(k in defaults)) defaults[k] = v
      }
    }
  }

  const result = []
  const seen = new Set()
  for (const b of blocks) {
    for (const alias of b.hosts) {
      if (/[*?]/.test(alias)) continue
      if (alias.toLowerCase() === 'global') continue
      const opts = { ...defaults, ...b.opts }
      const cfgHost = opts.hostname || alias
      const host = cfgHost.replace(/^\[|\]$/g, '').split(':')[0]
      const port = Number(opts.port) || 22
      const username = opts.user || ''
      const key = `${host}:${port}:${username}`
      if (seen.has(key)) continue
      seen.add(key)
      const idFile = opts.identityfile ? expandPath(opts.identityfile) : ''
      result.push({
        id: crypto.randomUUID(),
        type: 'ssh',
        name: alias,
        group: '导入',
        host,
        port,
        username,
        authType: idFile ? 'key' : 'password',
        privateKeyPath: idFile,
        keepalive: 30,
        autoReconnect: true
      })
    }
  }
  return result
}

module.exports = { importSshConfig }
