'use strict'
/**
 * 配置持久化。
 * - 连接配置存于 userData/shellink.json
 * - 密码 / 私钥口令使用操作系统级加密（Windows DPAPI，经 Electron safeStorage）保存
 */
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

const SECRET_FIELDS = [
  ['password', 'passwordEnc'],
  ['privateKeyPass', 'privateKeyPassEnc']
]

const DEFAULTS = {
  version: 1,
  profiles: [],
  settings: {
    theme: 'light',
    fontSize: 13,
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    copyOnSelect: false,
    rightClickPaste: true,
    scrollback: 8000,
    cursorBlink: true,
    colorTerminal: false,
    confirmOnClose: true,
    sftpVisible: false,
    sidebarVisible: true,
    sidebarWidth: 236
  },
  window: { width: 1180, height: 760, x: null, y: null, maximized: false },
  recent: []
}

function encryptSecret (plain) {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'e:' + safeStorage.encryptString(plain).toString('base64')
    }
  } catch (_) { /* 回落 */ }
  return 'p:' + Buffer.from(plain, 'utf8').toString('base64')
}

function decryptSecret (value) {
  if (!value) return ''
  try {
    if (value.startsWith('e:')) {
      return safeStorage.decryptString(Buffer.from(value.slice(2), 'base64'))
    }
    if (value.startsWith('p:')) {
      return Buffer.from(value.slice(2), 'base64').toString('utf8')
    }
  } catch (_) { /* 换了机器或用户，解不开就当空 */ }
  return ''
}

function clone (v) {
  return JSON.parse(JSON.stringify(v))
}

class Store {
  constructor () {
    this.file = path.join(app.getPath('userData'), 'shellink.json')
    this.data = clone(DEFAULTS)
    this._timer = null
    this._loaded = false
  }

  load () {
    this.migrateLegacy()
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = {
        ...clone(DEFAULTS),
        ...parsed,
        settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
        window: { ...DEFAULTS.window, ...(parsed.window || {}) }
      }
      if (!Array.isArray(this.data.profiles)) this.data.profiles = []
    } catch (_) {
      this.data = clone(DEFAULTS)
    }
    // 解密敏感字段到内存
    this.data.profiles = this.data.profiles.map(p => {
      const next = { ...p }
      for (const [plainKey, encKey] of SECRET_FIELDS) {
        next[plainKey] = decryptSecret(next[encKey])
        delete next[encKey]
      }
      return next
    })
    this._loaded = true
    return this.data
  }

  /** 早期版本（ShellPilot）的配置自动搬过来 */
  migrateLegacy () {
    try {
      if (process.env.SP_SHOT_DATA) return // 联调用的临时数据目录不迁移
      if (fs.existsSync(this.file)) return
      const candidates = [
        path.join(app.getPath('userData'), 'shellpilot.json'),
        path.join(app.getPath('appData'), 'ShellPilot', 'shellpilot.json')
      ]
      for (const src of candidates) {
        if (!fs.existsSync(src)) continue
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.copyFileSync(src, this.file)
        console.log('[store] 已迁移旧配置:', src)
        return
      }
    } catch (_) { /* 迁移失败就按新配置走 */ }
  }

  serialize () {
    const out = clone(this.data)
    out.profiles = out.profiles.map(p => {
      const next = { ...p }
      for (const [plainKey, encKey] of SECRET_FIELDS) {
        next[encKey] = encryptSecret(next[plainKey])
        delete next[plainKey]
      }
      return next
    })
    return out
  }

  save () {
    if (!this._loaded) return
    clearTimeout(this._timer)
    this._timer = setTimeout(() => this.saveNow(), 200)
  }

  saveNow () {
    clearTimeout(this._timer)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.serialize(), null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error('[store] save failed:', e.message)
    }
  }

  get settings () { return this.data.settings }

  updateSettings (patch) {
    this.data.settings = { ...this.data.settings, ...patch }
    this.save()
    return this.data.settings
  }

  upsertProfile (profile) {
    const list = this.data.profiles
    const idx = list.findIndex(p => p.id === profile.id)
    if (idx >= 0) list[idx] = { ...list[idx], ...profile }
    else list.push(profile)
    this.save()
    return profile
  }

  deleteProfile (id) {
    this.data.profiles = this.data.profiles.filter(p => p.id !== id)
    this.save()
  }

  setProfiles (list) {
    this.data.profiles = list
    this.save()
  }

  touchRecent (id) {
    const recent = (this.data.recent || []).filter(x => x !== id)
    recent.unshift(id)
    this.data.recent = recent.slice(0, 12)
    this.save()
  }

  get windowState () { return this.data.window }

  setWindowState (patch) {
    this.data.window = { ...this.data.window, ...patch }
    this.save()
  }
}

module.exports = { Store, encryptSecret, decryptSecret }
