'use strict'
/**
 * Shellink 主进程
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const { Store } = require('./store')
const { detectShells } = require('./shells')
const { createSession } = require('./session')
const { importSshConfig } = require('./ssh-config-import')

const isDev = process.argv.includes('--dev')
const shotMode = process.argv.includes('--screenshot')
const isMac = process.platform === 'darwin'

// 联调/截图专用：允许把数据目录指到临时位置，避免污染真实配置
if (process.env.SP_SHOT_DATA) {
  try { app.setPath('userData', path.resolve(process.env.SP_SHOT_DATA)) } catch (_) {}
}

let mainWindow = null
let pendingCli = null
const store = new Store()
const sessions = new Map()

/**
 * 解析命令行参数（由 shlnk 命令传入）
 *   shlnk user@host:2222   → { connect: 'user@host:2222' }
 *   shlnk --local          → { local: true }
 */
function parseCliArgs (argv) {
  const start = app.isPackaged ? 1 : 2
  const args = argv.slice(start).filter(a => !['--dev', '--screenshot', '.'].includes(a))
  const out = { connect: '', local: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--connect' || a === '-c') { out.connect = args[++i] || ''; continue }
    if (a === '--local' || a === '-l') { out.local = true; continue }
    if (a.startsWith('-')) continue
    if (!out.connect) out.connect = a
  }
  return out
}

/* ------------------------------------------------------------- 窗口 */

function createWindow () {
  const state = store.windowState
  mainWindow = new BrowserWindow({
    width: state.width || 1180,
    height: state.height || 760,
    x: state.x === null ? undefined : state.x,
    y: state.y === null ? undefined : state.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f7f7',
    title: 'Shellink',
    autoHideMenuBar: false,
    icon: path.join(__dirname, '../renderer/assets/logo.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
    query: process.env.SP_SHOT_AUTO ? { auto: process.env.SP_SHOT_AUTO } : {}
  })

  mainWindow.once('ready-to-show', () => {
    if (state.maximized) mainWindow.maximize()
    mainWindow.show()
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
    if (shotMode) captureAndQuit()
  })

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMaximized()) {
      store.setWindowState({ maximized: true })
      return
    }
    const b = mainWindow.getBounds()
    store.setWindowState({ ...b, maximized: false })
  }
  mainWindow.on('resize', debounce(persistBounds, 400))
  mainWindow.on('move', debounce(persistBounds, 400))
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.on('maximize', () => store.setWindowState({ maximized: true }))
  mainWindow.on('unmaximize', () => store.setWindowState({ maximized: false }))

  // 外链走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

function debounce (fn, ms) {
  let t = null
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

/** 联调/截图专用：从文件注入演示用连接配置 */
function seedForShot () {
  if (!process.env.SP_SHOT_SEED_FILE) return
  try {
    const seed = JSON.parse(fs.readFileSync(process.env.SP_SHOT_SEED_FILE, 'utf8'))
    const profiles = Array.isArray(seed) ? seed : (seed.profiles || [])
    for (const p of profiles) {
      store.data.profiles.push({ ...p, id: p.id || crypto.randomUUID() })
    }
    if (!Array.isArray(seed) && seed.settings) {
      store.data.settings = { ...store.data.settings, ...seed.settings }
    }
    store.saveNow()
  } catch (e) {
    console.error('[shot] 注入演示数据失败:', e.message)
  }
}

async function captureAndQuit () {
  try {
    await new Promise(r => setTimeout(r, 1200))
    // 自检：未指定 auto 打开时，自动开一个本地终端验证 PTY 链路
    if (!process.env.SP_SHOT_AUTO && !process.env.SP_SHOT_WELCOME) {
      mainWindow.webContents.send('menu:action', 'new-local')
    }
    await new Promise(r => setTimeout(r, 3500))
    if (process.env.SP_SHOT_ACTION) {
      mainWindow.webContents.send('menu:action', process.env.SP_SHOT_ACTION)
      await new Promise(r => setTimeout(r, 700))
    }
    if (process.env.SP_SHOT_JS) {
      try {
        const ret = await mainWindow.webContents.executeJavaScript(process.env.SP_SHOT_JS)
        if (ret !== undefined) console.log('[shot:js]', typeof ret === 'string' ? ret : JSON.stringify(ret))
      } catch (e) {
        console.error('[screenshot] js failed', e.message)
      }
      await new Promise(r => setTimeout(r, 900))
    }
    const img = await mainWindow.webContents.capturePage()
    const out = path.join(process.cwd(), process.env.SP_SHOT_OUT || 'screenshot.png')
    fs.writeFileSync(out, img.toPNG())
    const crop = await mainWindow.webContents.capturePage({ x: 760, y: 260, width: 420, height: 420 })
    fs.writeFileSync(path.join(process.cwd(), 'screenshot-detail.png'), crop.toPNG())
    console.log('[screenshot] saved to', out)
  } catch (e) {
    console.error('[screenshot] failed', e)
  }
  setTimeout(() => app.quit(), 300)
}

/* ------------------------------------------------------------- 菜单 */

function buildMenu () {
  const send = (action) => () => mainWindow && mainWindow.webContents.send('menu:action', action)
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建连接', accelerator: 'CmdOrCtrl+N', click: send('new-ssh') },
        { label: '打开本地终端', accelerator: 'CmdOrCtrl+T', click: send('new-local') },
        { label: '快速连接', accelerator: 'CmdOrCtrl+Shift+N', click: send('quick-connect') },
        { type: 'separator' },
        { label: '从 SSH 配置导入…', click: send('import-ssh') },
        { label: '导出连接配置…', click: send('export') },
        { type: 'separator' },
        { label: '关闭当前标签', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '复制', accelerator: 'CmdOrCtrl+Shift+C', click: send('copy') },
        { label: '粘贴', accelerator: 'CmdOrCtrl+Shift+V', click: send('paste') },
        { label: '全选', click: send('select-all') },
        { type: 'separator' },
        { label: '查找', accelerator: 'CmdOrCtrl+F', click: send('search') },
        { label: '清屏', accelerator: 'CmdOrCtrl+K', click: send('clear') }
      ]
    },
    {
      label: '查看',
      submenu: [
        { label: '会话管理器', accelerator: 'CmdOrCtrl+Shift+S', click: send('toggle-sidebar') },
        { label: '文件传输', accelerator: 'CmdOrCtrl+Shift+E', click: send('toggle-sftp') },
        { type: 'separator' },
        { label: '放大字号', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: '缩小字号', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: '重置字号', accelerator: 'CmdOrCtrl+0', click: send('zoom-reset') },
        { type: 'separator' },
        { label: '切换明暗主题', accelerator: 'CmdOrCtrl+Shift+L', click: send('toggle-theme') },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '工具',
      submenu: [
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 Shellink', click: send('about') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------- 会话事件桥接 */

function bridgeSession (session) {
  sessions.set(session.id, session)
  const wc = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)

  session.on('data', (chunk) => {
    const w = wc()
    if (w) w.send('session:data', session.id, chunk)
  })
  session.on('status', (payload) => {
    const w = wc()
    if (w) w.send('session:status', session.id, payload)
  })
  session.on('exit', (payload) => {
    const w = wc()
    if (w) w.send('session:exit', session.id, payload)
    setTimeout(() => sessions.delete(session.id), 5000)
  })
  session.on('prompt', (payload) => {
    const w = wc()
    if (w) w.send('session:prompt', session.id, payload)
  })
  session.on('prompt-cancel', () => {
    const w = wc()
    if (w) w.send('session:prompt-cancel', session.id)
  })
  session.on('progress', (payload) => {
    const w = wc()
    if (w) w.send('sftp:progress', session.id, payload)
  })
}

/* --------------------------------------------------------------- IPC */

function registerIpc () {
  ipcMain.handle('app:bootstrap', () => {
    const cli = pendingCli
    pendingCli = null // 只消费一次，刷新页面时不再重复打开
    return {
      profiles: store.data.profiles,
      settings: store.settings,
      recent: store.data.recent || [],
      shells: detectShells(),
      version: app.getVersion(),
      productName: app.getName(),
      platform: process.platform,
      cli
    }
  })

  ipcMain.handle('settings:save', (e, patch) => store.updateSettings(patch))

  ipcMain.handle('profile:save', (e, profile) => {
    const next = { ...profile, id: profile.id || crypto.randomUUID() }
    store.upsertProfile(next)
    return next
  })

  ipcMain.handle('profile:delete', (e, id) => {
    store.deleteProfile(id)
    return true
  })

  ipcMain.handle('profile:export', async () => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出连接配置',
      defaultPath: 'shellink-connections.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    // 导出不携带任何凭据明文，避免配置在机器之外泄露
    const safeProfiles = store.data.profiles.map(p => {
      const next = { ...p }
      delete next.password
      delete next.privateKeyPass
      delete next.privateKey
      return next
    })
    const payload = { app: 'Shellink', version: 1, profiles: safeProfiles }
    fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: res.filePath }
  })

  ipcMain.handle('profile:import', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入连接配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths.length) return { ok: false, count: 0 }
    try {
      const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'))
      const list = Array.isArray(raw) ? raw : (raw.profiles || [])
      let count = 0
      for (const p of list) {
        if (!p || !p.type) continue
        store.upsertProfile({ ...p, id: crypto.randomUUID() })
        count++
      }
      return { ok: true, count, profiles: store.data.profiles }
    } catch (e) {
      return { ok: false, count: 0, error: e.message }
    }
  })

  ipcMain.handle('profile:import-ssh-config', () => {
    const found = importSshConfig()
    const existing = store.data.profiles
    let added = 0
    for (const p of found) {
      const dup = existing.some(x => x.type === 'ssh' && x.host === p.host && Number(x.port) === Number(p.port) && x.username === p.username)
      if (!dup) {
        store.upsertProfile(p)
        added++
      }
    }
    return { ok: true, added, total: found.length, profiles: store.data.profiles }
  })

  ipcMain.handle('session:open', (e, { profile, cols, rows }) => {
    const id = crypto.randomUUID()
    const session = createSession({ id, profile, cols: cols || 100, rows: rows || 30 })
    bridgeSession(session)
    session.start()
    if (profile && profile.id) store.touchRecent(profile.id)
    return { id }
  })

  ipcMain.handle('session:close', (e, id) => {
    const s = sessions.get(id)
    if (s) s.close()
    return true
  })

  ipcMain.handle('session:input', (e, { id, data }) => {
    const s = sessions.get(id)
    if (s) s.write(data)
    return true
  })

  ipcMain.handle('session:resize', (e, { id, cols, rows }) => {
    const s = sessions.get(id)
    if (s) s.resize(cols, rows)
    return true
  })

  ipcMain.handle('session:answer', (e, { id, value }) => {
    const s = sessions.get(id)
    if (s && s.answerPrompt) s.answerPrompt(value)
    return true
  })

  ipcMain.handle('session:test', (e, profile) => new Promise((resolve) => {
    const { SshSession } = require('./session')
    const probe = new SshSession({ id: 'probe', profile })
    let done = false
    const finish = (ok, message) => {
      if (done) return
      done = true
      try { probe.close() } catch (_) {}
      resolve({ ok, message })
    }
    const timer = setTimeout(() => finish(false, '测试超时（20 秒）'), 20000)
    probe.on('status', (st) => {
      if (st.state === 'connected') {
        clearTimeout(timer)
        finish(true, '连接成功')
      } else if (st.state === 'error') {
        clearTimeout(timer)
        finish(false, st.message)
      }
    })
    probe.on('exit', () => {
      clearTimeout(timer)
      if (!done) finish(false, '连接已关闭')
    })
    probe.connect()
  }))

  /* ------------------------------------------------------------ SFTP */

  ipcMain.handle('sftp:home', async (e, id) => {
    const s = sessions.get(id)
    if (!s || !s.ensureSftp) throw new Error('当前会话不支持文件传输')
    return { path: await s.home() }
  })

  ipcMain.handle('sftp:list', async (e, { id, path: p }) => {
    const s = sessions.get(id)
    if (!s || !s.ensureSftp) throw new Error('当前会话不支持文件传输')
    return s.list(p)
  })

  ipcMain.handle('sftp:mkdir', async (e, { id, path: p }) => {
    const s = sessions.get(id)
    await s.mkdir(p)
    return true
  })

  ipcMain.handle('sftp:rename', async (e, { id, from, to }) => {
    const s = sessions.get(id)
    await s.rename(from, to)
    return true
  })

  ipcMain.handle('sftp:delete', async (e, { id, path: p, isDir }) => {
    const s = sessions.get(id)
    await s.remove(p, isDir)
    return true
  })

  ipcMain.handle('sftp:download', async (e, { id, remotePath }) => {
    const s = sessions.get(id)
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载到的文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    const target = await s.download(remotePath, res.filePaths[0])
    return { ok: true, target }
  })

  ipcMain.handle('sftp:upload', async (e, { id, remoteDir }) => {
    const s = sessions.get(id)
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    const uploaded = []
    for (const f of res.filePaths) {
      uploaded.push(await s.upload(f, remoteDir))
    }
    return { ok: true, uploaded }
  })

  /* ---------------------------------------------------------- 其他 */

  ipcMain.handle('dialog:pick-file', async (e, { title, filters }) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: title || '选择文件',
      properties: ['openFile'],
      filters: filters || []
    })
    return res.canceled ? '' : res.filePaths[0]
  })

  ipcMain.handle('dialog:pick-dir', async (e, { title }) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: title || '选择文件夹',
      properties: ['openDirectory']
    })
    return res.canceled ? '' : res.filePaths[0]
  })

  ipcMain.handle('app:copy', (e, text) => {
    clipboard.writeText(text || '')
    return true
  })

  ipcMain.handle('app:paste', () => clipboard.readText())

  ipcMain.handle('app:home-dir', () => os.homedir())

  ipcMain.handle('app:confirm-close', (e, { count }) => {
    if (!count) return { action: 'close' }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['最小化到托盘', '直接退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      title: '还有会话在运行',
      message: `当前有 ${count} 个会话正在运行，确定要退出吗？`
    })
    return { action: choice === 0 ? 'minimize' : choice === 1 ? 'close' : 'cancel' }
  })
}

/* ------------------------------------------------------------- 生命周期 */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      const cli = parseCliArgs(argv)
      if (cli.connect || cli.local) mainWindow.webContents.send('cli:open', cli)
    }
  })

  pendingCli = parseCliArgs(process.argv)

  app.whenReady().then(() => {
    store.load()
    seedForShot()
    nativeTheme.themeSource = store.settings.theme === 'dark' ? 'dark' : 'light'
    registerIpc()
    buildMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    store.saveNow()
    if (!isMac) app.quit()
  })

  app.on('before-quit', () => {
    for (const s of sessions.values()) {
      try { s.close() } catch (_) {}
    }
    store.saveNow()
  })
}
