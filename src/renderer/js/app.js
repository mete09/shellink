/* Shellink 渲染进程主逻辑 */
(function () {
  'use strict'

  const state = {
    profiles: [],
    settings: {},
    shells: [],
    recent: [],
    version: '',
    tabs: [],
    activeId: null,
    filter: '',
    collapsed: new Set()
  }

  const pendingData = new Map()
  const pendingStatus = new Map()
  const pendingExit = new Set()
  let filePanel = null
  let searchOpen = false

  const $ = (sel) => document.querySelector(sel)
  const uid = () => Math.random().toString(36).slice(2, 10)

  /* ------------------------------------------------------------ 初始化 */

  async function boot () {
    const data = await window.api.bootstrap()
    state.profiles = data.profiles || []
    state.settings = data.settings || {}
    state.shells = data.shells || []
    state.recent = data.recent || []
    state.version = data.version || '1.0.0'

    applyTheme(state.settings.theme)
    paintStatic()
    bindEvents()

    filePanel = new SP.FilePanel()
    setSidebarVisible(state.settings.sidebarVisible !== false, true)
    applySidebarWidth(state.settings.sidebarWidth || 236)
    renderTree()
    renderRecent()
    renderTabs()
    showWelcome(true)
    updateStatusbar()

    if (state.settings.sftpVisible) setSftpVisible(true)

    // 命令行传入的连接（shlnk user@host）
    if (data.cli && data.cli.local) openLocalShell()
    else if (data.cli && data.cli.connect) quickConnect(data.cli.connect)

    // 自动化截图/联调入口：index.html?auto=连接名
    const auto = new URLSearchParams(location.search).get('auto')
    if (auto) {
      const p = state.profiles.find(x => x.name === auto)
      if (p) openProfile(p)
      else openLocalShell()
    }
  }

  function paintStatic () {
    $('#btn-side-new').innerHTML = SP.icon('plus', 14)
    $('#btn-side-import').innerHTML = SP.icon('importIcon', 14)
    $('#search-icon').innerHTML = SP.icon('search', 13)
    $('#tb-new').innerHTML = `${SP.icon('plus', 14)}<span>新建</span>`
    $('#tb-local').innerHTML = `${SP.icon('terminal', 14)}<span>本地终端</span>`
    $('#tb-import').innerHTML = `${SP.icon('importIcon', 14)}<span>导入</span>`
    $('#tb-sessions').innerHTML = `${SP.icon('list', 14)}<span>会话管理器</span>`
    $('#tb-sftp').innerHTML = `${SP.icon('panel', 14)}<span>文件传输</span>`
    $('#tb-copy').innerHTML = `${SP.icon('copy', 14)}<span>复制</span>`
    $('#tb-paste').innerHTML = `${SP.icon('clipboard', 14)}<span>粘贴</span>`
    $('#tb-search').innerHTML = `${SP.icon('search', 14)}<span>查找</span>`
    $('#tb-clear').innerHTML = `${SP.icon('eraser', 14)}<span>清屏</span>`
    $('#tb-settings').innerHTML = `${SP.icon('sliders', 14)}<span>设置</span>`
    $('#qc-icon').innerHTML = SP.icon('plug', 13)
    $('#btn-new-tab').innerHTML = SP.icon('plus', 15)
    $('#btn-local-quick').innerHTML = `${SP.icon('terminal', 14)}<span>打开本地终端</span>`
    $('#welcome-new-ssh').innerHTML = `${SP.icon('plus', 14)}<span>新建 SSH 连接</span>`
    $('#welcome-new-local').innerHTML = `${SP.icon('terminal', 14)}<span>打开本地终端</span>`
  }

  /* ------------------------------------------------------------ 会话管理器 */

  function matchProfile (p, q) {
    const hay = [p.name, p.host, p.username, p.group, p.local && p.local.name]
      .filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  }

  function isExpanded (key, searching) {
    return searching ? true : !state.collapsed.has(key)
  }

  function folderRow (key, name, depth, count, searching) {
    const open = isExpanded(key, searching)
    return `<div class="tree-row folder ${open ? '' : 'collapsed'}" data-folder="${SP.esc(key)}" style="padding-left:${8 + depth * 14}px">
      <span class="twisty">${SP.icon('chevron', 11)}</span>
      <span class="node-icon">${SP.icon('folder', 14)}</span>
      <span class="node-label">${SP.esc(name)}</span>
      ${count ? `<span class="node-badge">${count}</span>` : ''}
    </div>`
  }

  function sessionRow (p, depth) {
    const active = isProfileActive(p)
    const sub = p.type === 'ssh'
      ? `${p.username ? p.username + '@' : ''}${p.host}:${p.port || 22}`
      : ((p.local && p.local.name) || '本地终端')
    return `<div class="tree-row ${active ? 'active' : ''}" data-profile="${SP.esc(p.id)}"
        style="padding-left:${8 + depth * 14}px" title="${SP.esc(p.name + '  ' + sub)}">
      <span class="twisty empty"></span>
      <span class="node-icon">${SP.icon(p.type === 'ssh' ? 'server' : 'terminal', 14)}</span>
      <span class="node-label">${SP.esc(p.name)}</span>
      <button class="node-more" data-more="${SP.esc(p.id)}">${SP.icon('more', 12)}</button>
    </div>`
  }

  function renderTree () {
    const q = state.filter.trim().toLowerCase()
    const searching = !!q
    const html = []

    // 本地终端
    const locals = state.shells.filter(s => !q || s.name.toLowerCase().includes(q))
    html.push(folderRow('root:local', '本地终端', 0, locals.length, searching))
    if (isExpanded('root:local', searching)) {
      if (!locals.length) html.push('<div class="empty-hint" style="padding-left:30px">未检测到可用的 Shell</div>')
      for (const s of locals) {
        html.push(`<div class="tree-row" data-shell="${SP.esc(s.id)}" style="padding-left:22px" title="${SP.esc(s.shell)}">
          <span class="twisty empty"></span>
          <span class="node-icon">${SP.icon('terminal', 14)}</span>
          <span class="node-label">${SP.esc(s.name)}</span>
        </div>`)
      }
    }

    // 我的服务器 → 分组 → 会话
    const list = state.profiles.filter(p => !q || matchProfile(p, q))
    html.push(folderRow('root:servers', '我的服务器', 0, list.length, searching))
    if (isExpanded('root:servers', searching)) {
      const groups = new Map()
      for (const p of list) {
        const g = p.group || '未分组'
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g).push(p)
      }
      if (!list.length) {
        html.push(`<div class="empty-hint" style="padding-left:30px">${q ? '没有匹配的会话' : '还没有保存的连接，点击工具栏「新建」开始。'}</div>`)
      }
      for (const [group, items] of groups) {
        const key = 'group:' + group
        html.push(folderRow(key, group, 1, items.length, searching))
        if (!isExpanded(key, searching)) continue
        for (const p of items) html.push(sessionRow(p, 2))
      }
    }

    $('#tree').innerHTML = html.join('')
  }

  function isProfileActive (p) {
    const tab = activeTab()
    return !!tab && !!p.id && tab.profile.id === p.id
  }

  function renderRecent () {
    const box = $('#recent-list')
    const items = state.recent
      .map(id => state.profiles.find(p => p.id === id))
      .filter(Boolean)
      .slice(0, 5)
    const block = box.parentElement
    if (!items.length) {
      block.style.display = 'none'
      box.innerHTML = ''
      return
    }
    block.style.display = ''
    box.innerHTML = items.map(p => `
      <div class="recent-row" data-profile="${SP.esc(p.id)}">
        <div class="r-avatar">${SP.icon(p.type === 'ssh' ? 'server' : 'terminal', 13)}</div>
        <div class="r-body">
          <div class="r-name">${SP.esc(p.name)}</div>
          <div class="r-sub">${SP.esc(p.type === 'ssh' ? `${p.username ? p.username + '@' : ''}${p.host}:${p.port || 22}` : '本地终端')}</div>
        </div>
      </div>`).join('')
  }

  /* ------------------------------------------------------------ 标签页 */

  function activeTab () {
    return state.tabs.find(t => t.id === state.activeId) || null
  }

  function tabBySession (sessionId) {
    return state.tabs.find(t => t.sessionId === sessionId) || null
  }

  function renderTabs () {
    const box = $('#tabs-scroll')
    box.innerHTML = state.tabs.map(t => `
      <div class="tab ${t.id === state.activeId ? 'active' : ''}" data-tab="${t.id}" title="${SP.esc(t.title)}">
        <span class="tab-dot ${t.status === 'connected' ? 'connected' : t.status === 'error' ? 'error' : t.status === 'closed' ? '' : 'connecting'}"></span>
        <span class="tab-title">${SP.esc(t.title)}</span>
        <span class="tab-close" data-close="${t.id}">${SP.icon('x', 12)}</span>
      </div>`).join('')
    const tab = activeTab()
    document.title = tab ? `${tab.title} — Shellink` : 'Shellink'
  }

  function showWelcome (show) {
    $('#welcome').classList.toggle('hidden', !show)
  }

  async function openTab (profile) {
    const tab = {
      id: uid(),
      sessionId: null,
      profile,
      title: profile.name || (profile.type === 'ssh' ? profile.host : '本地终端'),
      status: 'connecting',
      message: '正在连接…',
      view: null,
      reconnectTimer: null,
      userClosed: false
    }
    state.tabs.push(tab)
    state.activeId = tab.id
    renderTabs()
    renderTree()
    showWelcome(false)
    updateStatusbar()
    await startSession(tab)
    activateTab(tab.id)
  }

  async function startSession (tab) {
    try {
      const { id } = await window.api.openSession({
        profile: tab.profile,
        cols: 110,
        rows: 30
      })
      tab.sessionId = id

      if (!tab.view) {
        tab.view = new SP.TerminalView({
          sessionId: id,
          settings: state.settings,
          onResize: () => updateStatusbar()
        })
        tab.view.mount($('#terms'))
      } else {
        tab.view.sessionId = id
      }
      tab.view.setActive(state.activeId === tab.id)
      tab.view.history = null

      const buffered = pendingData.get(id)
      if (buffered) {
        buffered.forEach(chunk => tab.view.write(chunk))
        pendingData.delete(id)
      }
      const statuses = pendingStatus.get(id)
      if (statuses) {
        statuses.forEach(st => applyStatus(tab, st))
        pendingStatus.delete(id)
      }
      if (pendingExit.has(id)) {
        pendingExit.delete(id)
        applyExit(tab)
      }
      if (state.activeId === tab.id) {
        tab.view.focus()
        if (state.settings.sftpVisible) filePanel.attach(tab)
      }
    } catch (e) {
      tab.status = 'error'
      tab.message = e.message || String(e)
      renderTabs()
      updateStatusbar()
      SP.toast(tab.message, 'err')
    }
  }

  function activateTab (id) {
    state.activeId = id
    for (const t of state.tabs) {
      if (t.view) t.view.setActive(t.id === id)
    }
    renderTabs()
    renderTree()
    showWelcome(!state.tabs.length)
    updateStatusbar()
    const tab = activeTab()
    if (tab) {
      if (tab.view) tab.view.focus()
      if (state.settings.sftpVisible) filePanel.attach(tab)
    }
  }

  function closeTab (id) {
    const idx = state.tabs.findIndex(t => t.id === id)
    if (idx < 0) return
    const tab = state.tabs[idx]
    tab.userClosed = true
    clearTimeout(tab.reconnectTimer)
    state.tabs.splice(idx, 1)
    if (tab.sessionId) window.api.closeSession(tab.sessionId)
    if (tab.view) tab.view.dispose()

    if (state.activeId === id) {
      const next = state.tabs[idx] || state.tabs[idx - 1] || null
      state.activeId = next ? next.id : null
      if (next) activateTab(next.id)
    }
    renderTabs()
    renderTree()
    showWelcome(!state.tabs.length)
    updateStatusbar()
    if (!state.tabs.length) {
      filePanel.sessionId = null
      filePanel.showPlaceholder('未打开会话')
    }
  }

  /* ------------------------------------------------------------ 会话事件 */

  function onSessionData (sessionId, chunk) {
    const tab = tabBySession(sessionId)
    if (tab && tab.view) tab.view.write(chunk)
    else {
      if (!pendingData.has(sessionId)) pendingData.set(sessionId, [])
      pendingData.get(sessionId).push(chunk)
    }
  }

  function onSessionStatus (sessionId, st) {
    const tab = tabBySession(sessionId)
    if (!tab) {
      if (!pendingStatus.has(sessionId)) pendingStatus.set(sessionId, [])
      pendingStatus.get(sessionId).push(st)
      return
    }
    applyStatus(tab, st)
  }

  function applyStatus (tab, st) {
    tab.status = st.state
    tab.message = st.message
    if (st.state === 'error') {
      if (tab.view) tab.view.writeln(`\r\n\x1b[1m✖ ${st.message}\x1b[0m`)
      SP.toast(st.message, 'err', 4200)
    }
    if (st.state === 'connected') {
      tab.fingerprint = st.fingerprint || ''
    }
    renderTabs()
    updateStatusbar()
    if (st.state === 'connected' && state.settings.sftpVisible && state.activeId === tab.id) {
      filePanel.attach(tab)
    }
  }

  function onSessionExit (sessionId) {
    const tab = tabBySession(sessionId)
    if (!tab) {
      pendingExit.add(sessionId)
      return
    }
    applyExit(tab)
  }

  function applyExit (tab) {
    if (tab.userClosed) return
    const lastMessage = tab.message || ''
    if (tab.view && tab.status !== 'error') {
      tab.view.writeln('\r\n\x1b[90m[会话已结束]\x1b[0m')
    }
    tab.status = 'closed'
    tab.message = '连接已断开'
    renderTabs()
    updateStatusbar()

    // 认证类失败重连也解决不了，避免无意义的循环
    const authLike = /认证失败|私钥|口令|主机密钥|算法不匹配|未输入密码/.test(lastMessage)
    if (tab.profile.autoReconnect && tab.profile.type === 'ssh' && !authLike) {
      scheduleReconnect(tab)
    }
  }

  function scheduleReconnect (tab) {
    if (tab.userClosed || !state.tabs.includes(tab)) return
    clearTimeout(tab.reconnectTimer)
    let count = 0
    const tryOnce = async () => {
      if (tab.userClosed || !state.tabs.includes(tab)) return
      count++
      tab.status = 'connecting'
      tab.message = `自动重连中（第 ${count} 次）…`
      renderTabs()
      updateStatusbar()
      if (tab.view) tab.view.writeln(`\r\n\x1b[90m[${count}] 正在自动重连…\x1b[0m`)
      await startSession(tab)
      if (!state.tabs.includes(tab)) return
      tab.reconnectTimer = setTimeout(() => {
        if (tab.status !== 'connected' && count < 10) tryOnce()
      }, 3000)
    }
    tab.reconnectTimer = setTimeout(tryOnce, 2500)
  }

  function reconnectTab (tab) {
    if (!tab) return
    clearTimeout(tab.reconnectTimer)
    tab.status = 'connecting'
    tab.message = '正在重新连接…'
    renderTabs()
    updateStatusbar()
    if (tab.sessionId) window.api.closeSession(tab.sessionId)
    tab.sessionId = null
    if (tab.view) {
      tab.view.write('\r\n\x1b[90m—— 重新连接 ——\x1b[0m\r\n')
    }
    startSession(tab)
  }

  /* ------------------------------------------------------- 认证提示 */

  function showPrompt (sessionId, payload) {
    const tab = tabBySession(sessionId)
    if (!tab || !tab.view) return
    const existed = tab.view.wrap.querySelector('.prompt-veil')
    if (existed) existed.remove()

    const isPassword = payload.kind === 'password'
    const veil = document.createElement('div')
    veil.className = 'prompt-veil'
    veil.innerHTML = `
      <div class="prompt-card">
        <h4>${isPassword ? '输入登录密码' : '需要额外验证'}</h4>
        <p>${SP.esc(payload.prompt || '服务器要求输入验证信息')}</p>
        <input class="input" type="${payload.echo === false ? 'password' : 'text'}" placeholder="请输入…" />
        <div class="row">
          <button class="btn btn-ghost btn-sm" data-cancel>取消</button>
          <button class="btn btn-primary btn-sm" data-ok>确定</button>
        </div>
      </div>`
    tab.view.wrap.appendChild(veil)
    const input = veil.querySelector('input')
    setTimeout(() => input.focus(), 30)
    const submit = (value) => {
      veil.remove()
      window.api.answerPrompt(sessionId, value)
      if (tab.view) tab.view.focus()
    }
    veil.querySelector('[data-ok]').onclick = () => submit(input.value)
    veil.querySelector('[data-cancel]').onclick = () => submit('')
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit(input.value)
      if (e.key === 'Escape') submit('')
    })
  }

  /* ------------------------------------------------------------ 状态栏 */

  function updateStatusbar () {
    const tab = activeTab()
    const dot = $('#sb-status').querySelector('.sb-dot')
    const label = $('#sb-status').querySelector('span')
    if (!tab) {
      dot.className = 'sb-dot'
      label.textContent = '未连接'
      $('#sb-host').textContent = ''
      $('#sb-size').textContent = ''
      $('#sb-status').title = ''
    } else {
      dot.className = 'sb-dot ' + (tab.status === 'connected' ? 'connected' : tab.status === 'error' ? 'error' : tab.status === 'closed' ? '' : 'connecting')
      label.textContent = ({ connected: '已连接', connecting: '连接中', error: '连接失败', closed: '已断开' }[tab.status]) || tab.message
      $('#sb-status').title = tab.message || ''
      $('#sb-host').textContent = tab.profile.type === 'ssh'
        ? `${tab.profile.username ? tab.profile.username + '@' : ''}${tab.profile.host}:${tab.profile.port || 22}`
        : (tab.profile.local ? tab.profile.local.name : '本地终端')
      const dims = tab.view && tab.view.term ? `${tab.view.term.cols} × ${tab.view.term.rows}` : ''
      $('#sb-size').textContent = dims
    }
    $('#sb-font').textContent = `字号 ${state.settings.fontSize}`
    $('#sb-theme').innerHTML = `${SP.icon(state.settings.theme === 'dark' ? 'moon' : 'sun', 12)}<span>${state.settings.theme === 'dark' ? '深色' : '浅色'}</span>`
    $('#tb-sftp').classList.toggle('on', !!state.settings.sftpVisible)
  }

  /* ------------------------------------------------------------ 主题 */

  function applyTheme (theme) {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'
  }

  function setTheme (theme) {
    state.settings.theme = theme
    applyTheme(theme)
    state.tabs.forEach(t => t.view && t.view.setTheme(theme, state.settings.colorTerminal))
    updateStatusbar()
    window.api.saveSettings({ theme })
  }

  function setFontSize (size) {
    const n = Math.max(9, Math.min(22, size))
    state.settings.fontSize = n
    state.tabs.forEach(t => t.view && t.view.setFontSize(n))
    updateStatusbar()
    window.api.saveSettings({ fontSize: n })
  }

  /* ------------------------------------------------- 面板：会话管理器 / 文件 */

  function setSidebarVisible (visible, silent) {
    state.settings.sidebarVisible = visible
    $('#shell').classList.toggle('no-sidebar', !visible)
    $('#tb-sessions').classList.toggle('on', visible)
    if (!silent) window.api.saveSettings({ sidebarVisible: visible })
    const tab = activeTab()
    if (tab && tab.view) tab.view.fit()
  }

  function applySidebarWidth (width) {
    const w = Math.max(180, Math.min(420, width))
    state.settings.sidebarWidth = w
    document.documentElement.style.setProperty('--side-w', w + 'px')
  }

  function setSftpVisible (visible) {
    state.settings.sftpVisible = visible
    filePanel.setVisible(visible)
    $('#tb-sftp').classList.toggle('on', visible)
    window.api.saveSettings({ sftpVisible: visible })
    if (visible) filePanel.attach(activeTab())
    const tab = activeTab()
    if (tab && tab.view) tab.view.fit()
  }

  /* ------------------------------------------------------- 终端交互 */

  function copySelection () {
    const tab = activeTab()
    if (!tab || !tab.view) return
    const sel = tab.view.getSelection()
    if (sel) {
      window.api.copyText(sel)
      SP.toast('已复制', 'ok', 1200)
    }
  }

  async function pasteClipboard () {
    const tab = activeTab()
    if (!tab || !tab.view) return
    const text = await window.api.pasteText()
    if (text) tab.view.paste(text)
  }

  function toggleSearch (force) {
    searchOpen = force === undefined ? !searchOpen : force
    const box = $('#term-search')
    box.classList.toggle('on', searchOpen)
    if (searchOpen) {
      $('#term-search-input').focus()
      $('#term-search-input').select()
    } else {
      const tab = activeTab()
      if (tab && tab.view) {
        tab.view.clearSearch()
        tab.view.focus()
      }
    }
  }

  /* ------------------------------------------------------------ 编辑 */

  function newProfile () {
    SP.openProfileEditor({
      profile: { type: 'ssh', authType: 'password', port: 22, keepalive: 30, timeout: 20, autoReconnect: true },
      shells: state.shells,
      onSave: async (data) => {
        const saved = await window.api.saveProfile(data)
        const idx = state.profiles.findIndex(p => p.id === saved.id)
        if (idx >= 0) state.profiles[idx] = saved
        else state.profiles.push(saved)
        renderTree()
        renderRecent()
        SP.toast('连接已保存', 'ok')
      }
    })
  }

  function editProfile (profile) {
    SP.openProfileEditor({
      profile,
      shells: state.shells,
      onSave: async (data) => {
        const saved = await window.api.saveProfile(data)
        const idx = state.profiles.findIndex(p => p.id === saved.id)
        if (idx >= 0) state.profiles[idx] = saved
        for (const t of state.tabs) {
          if (t.profile.id === saved.id) {
            t.profile = { ...saved }
            t.title = saved.name
          }
        }
        renderTree()
        renderTabs()
        renderRecent()
        updateStatusbar()
        SP.toast('已保存修改', 'ok')
      },
      onDelete: async (p) => {
        await window.api.deleteProfile(p.id)
        state.profiles = state.profiles.filter(x => x.id !== p.id)
        renderTree()
        renderRecent()
        SP.toast('连接已删除', 'ok')
      }
    })
  }

  function duplicateProfile (profile) {
    const copy = { ...profile, id: '', name: profile.name + ' 副本' }
    SP.openProfileEditor({
      profile: copy,
      shells: state.shells,
      onSave: async (data) => {
        const saved = await window.api.saveProfile(data)
        state.profiles.push(saved)
        renderTree()
        SP.toast('副本已创建', 'ok')
      }
    })
  }

  function openLocalShell (shellId) {
    const shell = state.shells.find(s => s.id === shellId) || state.shells[0]
    if (!shell) {
      SP.toast('未检测到可用的 Shell', 'err')
      return
    }
    openTab({
      type: 'local',
      name: shell.name,
      local: { id: shell.id, name: shell.name, shell: shell.shell, args: shell.args }
    })
  }

  function openProfile (profile) {
    if (profile.type === 'local' && (!profile.local || !profile.local.shell)) {
      return openLocalShell(profile.local && profile.local.id)
    }
    openTab(profile)
  }

  /* ------------------------------------------------------- 快速连接 */

  function parseTarget (raw) {
    const text = String(raw || '').trim()
    if (!text) return null
    let user = ''
    let rest = text
    const at = rest.lastIndexOf('@')
    if (at > 0) {
      user = rest.slice(0, at)
      rest = rest.slice(at + 1)
    }
    let port = 22
    const m = rest.match(/^(.*?):(\d+)$/)
    if (m) {
      rest = m[1]
      port = Number(m[2]) || 22
    }
    if (!rest) return null
    return { host: rest, username: user, port }
  }

  function quickConnect (raw) {
    const target = parseTarget(raw)
    if (!target) {
      SP.toast('请输入 user@host:port 形式的地址', 'err')
      return
    }
    openTab({
      type: 'ssh',
      name: target.host,
      group: '',
      host: target.host,
      username: target.username,
      port: target.port,
      authType: 'password',
      password: '',
      keepalive: 30,
      timeout: 20,
      autoReconnect: false
    })
    $('#qc-input').value = ''
  }

  /* ------------------------------------------------------------ 设置 */

  function openSettings () {
    const s = state.settings
    const body = `
      <div class="section-label">外观</div>
      <div class="field">
        <label>主题</label>
        <div class="segmented" data-seg="theme">
          <button data-value="light" class="${s.theme !== 'dark' ? 'on' : ''}">浅色</button>
          <button data-value="dark" class="${s.theme === 'dark' ? 'on' : ''}">深色</button>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>终端字号</label>
          <input class="input" data-f="fontSize" value="${s.fontSize}" />
        </div>
        <div class="field">
          <label>回滚行数</label>
          <input class="input" data-f="scrollback" value="${s.scrollback}" />
        </div>
      </div>
      <div class="field">
        <label>终端字体</label>
        <input class="input" data-f="fontFamily" value="${SP.esc(s.fontFamily)}" />
      </div>
      <div class="field">
        <label class="checkbox"><input type="checkbox" data-f="colorTerminal" ${s.colorTerminal ? 'checked' : ''} /> 终端使用彩色输出（关闭则为单色）</label>
      </div>
      <div class="divider"></div>
      <div class="section-label">交互</div>
      <div class="field">
        <label class="checkbox"><input type="checkbox" data-f="copyOnSelect" ${s.copyOnSelect ? 'checked' : ''} /> 选中文本后自动复制</label>
      </div>
      <div class="field">
        <label class="checkbox"><input type="checkbox" data-f="rightClickPaste" ${s.rightClickPaste !== false ? 'checked' : ''} /> 右键粘贴（无选中内容时）</label>
      </div>
      <div class="divider"></div>
      <div class="section-label">连接数据</div>
      <div class="field" style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" data-act="import-ssh">${SP.icon('server', 13)}<span>从 ~/.ssh/config 导入</span></button>
        <button class="btn btn-ghost btn-sm" data-act="export">${SP.icon('download', 13)}<span>导出配置</span></button>
        <button class="btn btn-ghost btn-sm" data-act="import">${SP.icon('upload', 13)}<span>导入配置</span></button>
      </div>
    `

    const foot = SP.el('div', '')
    foot.style.cssText = 'display:flex;width:100%;gap:8px;align-items:center'
    foot.innerHTML = '<span style="flex:1"></span><button class="btn btn-primary" data-act="done">完成</button>'

    const modal = SP.modal({
      title: '设置',
      body,
      footer: foot,
      width: 520,
      onMount: (m) => {
        m.body.querySelector('[data-seg="theme"]').addEventListener('click', (e) => {
          const btn = e.target.closest('button[data-value]')
          if (!btn) return
          SP.$$('[data-seg="theme"] button', m.body).forEach(b => b.classList.toggle('on', b === btn))
          setTheme(btn.dataset.value)
        })

        m.body.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-act]')
          if (!btn) return
          const act = btn.dataset.act
          if (act === 'import-ssh') await importSshConfig()
          if (act === 'export') await exportProfiles()
          if (act === 'import') await importProfiles()
        })

        m.body.addEventListener('change', (e) => {
          const f = e.target.dataset.f
          if (!f) return
          if (f === 'fontSize') setFontSize(Number(e.target.value) || 13)
          if (f === 'scrollback') {
            const v = Number(e.target.value) || 8000
            state.settings.scrollback = v
            state.tabs.forEach(t => t.view && (t.view.term.options.scrollback = v))
            window.api.saveSettings({ scrollback: v })
          }
          if (f === 'fontFamily') {
            state.settings.fontFamily = e.target.value
            state.tabs.forEach(t => t.view && (t.view.term.options.fontFamily = e.target.value))
            window.api.saveSettings({ fontFamily: e.target.value })
          }
          if (f === 'colorTerminal') {
            state.settings.colorTerminal = e.target.checked
            state.tabs.forEach(t => t.view && t.view.setTheme(state.settings.theme, e.target.checked))
            window.api.saveSettings({ colorTerminal: e.target.checked })
          }
          if (f === 'copyOnSelect' || f === 'rightClickPaste') {
            state.settings[f] = e.target.checked
            window.api.saveSettings({ [f]: e.target.checked })
          }
        })

        foot.querySelector('[data-act="done"]').onclick = () => m.close()
      }
    })
    return modal
  }

  /* ------------------------------------------------------------ 关于 */

  function openAbout () {
    const foot = SP.el('div', '')
    foot.style.cssText = 'display:flex;width:100%;justify-content:flex-end'
    foot.innerHTML = '<button class="btn btn-primary" data-act="done">确定</button>'

    const modal = SP.modal({
      title: '关于',
      width: 320,
      body: `
        <div class="about">
          <img src="assets/logo.png" alt="" />
          <div class="about-name">Shellink</div>
          <div class="about-version">v${SP.esc(state.version)}</div>
          <div class="about-author">开发者：Mete</div>
        </div>`,
      footer: foot,
      onMount: (m) => {
        foot.querySelector('[data-act="done"]').onclick = () => m.close()
      }
    })
    return modal
  }

  /* ------------------------------------------------------- 导入导出 */

  async function importSshConfig () {
    const res = await window.api.importSshConfig()
    state.profiles = res.profiles
    renderTree()
    renderRecent()
    SP.toast(res.added ? `已导入 ${res.added} 个主机` : '没有发现新主机', res.added ? 'ok' : 'info')
  }

  async function importProfiles () {
    const res = await window.api.importProfiles()
    if (res.ok) {
      state.profiles = res.profiles
      renderTree()
      renderRecent()
      SP.toast(`已导入 ${res.count} 个连接`, 'ok')
    } else if (res.error) {
      SP.toast(res.error, 'err')
    }
  }

  async function exportProfiles () {
    const res = await window.api.exportProfiles()
    if (res.ok) SP.toast('配置已导出', 'ok')
  }

  /* ------------------------------------------------------------ 事件 */

  function openSessionMenu (p, x, y) {
    SP.openMenu(x, y, [
      { label: '打开会话', icon: 'terminal', onClick: () => openProfile(p) },
      { label: '编辑属性', icon: 'edit', onClick: () => editProfile(p) },
      { label: '创建副本', icon: 'copy', onClick: () => duplicateProfile(p) },
      { sep: true },
      {
        label: '删除',
        icon: 'trash',
        onClick: async () => {
          const ok = await SP.confirm({ title: '删除连接', message: `确定删除 “${p.name}” 吗？`, okText: '删除', danger: true })
          if (!ok) return
          await window.api.deleteProfile(p.id)
          state.profiles = state.profiles.filter(x => x.id !== p.id)
          renderTree()
          renderRecent()
        }
      }
    ])
  }

  function bindEvents () {
    /* 会话树 */
    const tree = $('#tree')

    const findProfile = (id) => state.profiles.find(x => x.id === id)

    tree.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]')
      if (more) {
        e.stopPropagation()
        const p = findProfile(more.dataset.more)
        if (!p) return
        const r = more.getBoundingClientRect()
        openSessionMenu(p, r.left - 60, r.bottom + 4)
        return
      }
      const folder = e.target.closest('[data-folder]')
      if (folder) {
        const key = folder.dataset.folder
        if (state.collapsed.has(key)) state.collapsed.delete(key)
        else state.collapsed.add(key)
        renderTree()
        return
      }
      const shell = e.target.closest('[data-shell]')
      if (shell) {
        openLocalShell(shell.dataset.shell)
        return
      }
      const item = e.target.closest('[data-profile]')
      if (item) {
        const p = findProfile(item.dataset.profile)
        if (p) openProfile(p)
      }
    })

    tree.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('[data-profile]')
      if (!item) return
      e.preventDefault()
      const p = findProfile(item.dataset.profile)
      if (p) openSessionMenu(p, e.clientX, e.clientY)
    })

    $('#recent-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-profile]')
      if (!row) return
      const p = findProfile(row.dataset.profile)
      if (p) openProfile(p)
    })

    $('#search-input').addEventListener('input', (e) => {
      state.filter = e.target.value
      renderTree()
    })

    /* 工具栏 */
    $('#tb-new').onclick = newProfile
    $('#tb-local').onclick = () => openLocalShell()
    $('#tb-import').onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      SP.openMenu(r.left, r.bottom + 6, [
        { label: '从 ~/.ssh/config 导入', icon: 'server', onClick: importSshConfig },
        { label: '导入 JSON 配置', icon: 'upload', onClick: importProfiles },
        { label: '导出 JSON 配置', icon: 'download', onClick: exportProfiles }
      ])
    }
    $('#tb-sessions').onclick = () => setSidebarVisible(!state.settings.sidebarVisible)
    $('#tb-sftp').onclick = () => setSftpVisible(!state.settings.sftpVisible)
    $('#tb-copy').onclick = copySelection
    $('#tb-paste').onclick = pasteClipboard
    $('#tb-search').onclick = () => toggleSearch(true)
    $('#tb-clear').onclick = () => {
      const tab = activeTab()
      if (tab && tab.view) tab.view.clear()
    }
    $('#tb-settings').onclick = openSettings

    $('#btn-side-new').onclick = newProfile
    $('#btn-side-import').onclick = importSshConfig
    $('#btn-local-quick').onclick = () => openLocalShell()
    $('#btn-new-tab').onclick = newProfile
    $('#welcome-new-ssh').onclick = newProfile
    $('#welcome-new-local').onclick = () => openLocalShell()

    /* 快速连接 */
    $('#qc-go').onclick = () => quickConnect($('#qc-input').value)
    $('#qc-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') quickConnect(e.currentTarget.value)
    })

    /* 拖动分隔条 */
    const splitter = $('#splitter')
    let dragging = false
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault()
      dragging = true
      document.body.style.cursor = 'col-resize'
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const left = $('#shell').getBoundingClientRect().left
      applySidebarWidth(e.clientX - left)
      const tab = activeTab()
      if (tab && tab.view) tab.view.fit()
    })
    window.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      document.body.style.cursor = ''
      window.api.saveSettings({ sidebarWidth: state.settings.sidebarWidth })
    })

    /* 标签栏 */
    $('#tabs-scroll').addEventListener('click', (e) => {
      const close = e.target.closest('[data-close]')
      if (close) {
        e.stopPropagation()
        closeTab(close.dataset.close)
        return
      }
      const tab = e.target.closest('[data-tab]')
      if (tab) activateTab(tab.dataset.tab)
    })

    $('#tabs-scroll').addEventListener('auxclick', (e) => {
      if (e.button !== 1) return
      const tab = e.target.closest('[data-tab]')
      if (tab) closeTab(tab.dataset.tab)
    })

    $('#tabs-scroll').addEventListener('contextmenu', (e) => {
      const node = e.target.closest('[data-tab]')
      if (!node) return
      e.preventDefault()
      const tab = state.tabs.find(t => t.id === node.dataset.tab)
      if (!tab) return
      if (tab.profile.id) {
        const p = findProfile(tab.profile.id)
        if (p) openSessionMenu(p, e.clientX, e.clientY)
      }
    })

    /* 状态栏 */
    $('#sb-font').onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      SP.openMenu(r.left - 60, r.top - 112, [
        { label: '放大字号', shortcut: 'Ctrl+=', onClick: () => setFontSize(state.settings.fontSize + 1) },
        { label: '缩小字号', shortcut: 'Ctrl+-', onClick: () => setFontSize(state.settings.fontSize - 1) },
        { label: '重置为 13', onClick: () => setFontSize(13) }
      ])
    }
    $('#sb-theme').onclick = () => setTheme(state.settings.theme === 'dark' ? 'light' : 'dark')

    /* 终端右键菜单 */
    $('#terms').addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const tab = activeTab()
      if (!tab || !tab.view) return
      const hasSel = tab.view.hasSelection()
      if (!hasSel && state.settings.rightClickPaste !== false) {
        pasteClipboard()
        return
      }
      SP.openMenu(e.clientX, e.clientY, [
        { label: '复制', icon: 'copy', shortcut: 'Ctrl+Shift+C', onClick: copySelection },
        { label: '粘贴', icon: 'clipboard', shortcut: 'Ctrl+Shift+V', onClick: pasteClipboard },
        { label: '全选', icon: 'check', onClick: () => tab.view.selectAll() },
        { sep: true },
        { label: '查找', icon: 'search', shortcut: 'Ctrl+F', onClick: () => toggleSearch(true) },
        { label: '清屏', icon: 'eraser', shortcut: 'Ctrl+K', onClick: () => tab.view.clear() },
        { sep: true },
        { label: '重新连接', icon: 'refresh', onClick: () => reconnectTab(tab) },
        { label: '关闭标签', icon: 'x', danger: true, onClick: () => closeTab(tab.id) }
      ])
    })

    /* 终端内搜索 */
    const searchInput = $('#term-search-input')
    searchInput.addEventListener('input', () => {
      const tab = activeTab()
      if (tab && tab.view) tab.view.findNext(searchInput.value)
    })
    searchInput.addEventListener('keydown', (e) => {
      const tab = activeTab()
      if (!tab || !tab.view) return
      if (e.key === 'Enter') {
        e.shiftKey ? tab.view.findPrev(searchInput.value) : tab.view.findNext(searchInput.value)
      }
      if (e.key === 'Escape') toggleSearch(false)
    })
    $('#search-next').onclick = () => {
      const tab = activeTab()
      if (tab && tab.view) tab.view.findNext(searchInput.value)
    }
    $('#search-prev').onclick = () => {
      const tab = activeTab()
      if (tab && tab.view) tab.view.findPrev(searchInput.value)
    }
    $('#search-close').onclick = () => toggleSearch(false)

    /* 主进程消息 */
    window.api.on('session:data', onSessionData)
    window.api.on('session:status', onSessionStatus)
    window.api.on('session:exit', onSessionExit)
    window.api.on('session:prompt', showPrompt)
    window.api.on('session:prompt-cancel', (sessionId) => {
      const tab = tabBySession(sessionId)
      if (!tab || !tab.view) return
      const veil = tab.view.wrap.querySelector('.prompt-veil')
      if (veil) veil.remove()
    })
    window.api.on('sftp:progress', (sessionId, payload) => {
      const tab = tabBySession(sessionId)
      if (tab && tab.id === state.activeId) filePanel.onProgress(payload)
    })
    window.api.on('menu:action', handleMenuAction)
    window.api.on('cli:open', (cli) => {
      if (cli.local) openLocalShell()
      else if (cli.connect) quickConnect(cli.connect)
    })

    /* 全局键盘 */
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === 'Tab') {
        e.preventDefault()
        if (state.tabs.length > 1) {
          const idx = state.tabs.findIndex(t => t.id === state.activeId)
          const next = state.tabs[(idx + (e.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length]
          activateTab(next.id)
        }
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'f' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault()
        toggleSearch(true)
      }
    })

    window.addEventListener('beforeunload', () => {
      for (const t of state.tabs) {
        if (t.sessionId) window.api.closeSession(t.sessionId)
      }
    })
  }

  function handleMenuAction (action) {
    const tab = activeTab()
    switch (action) {
      case 'new-ssh': newProfile(); break
      case 'new-local': openLocalShell(); break
      case 'quick-connect': $('#qc-input').focus(); break
      case 'import-ssh': importSshConfig(); break
      case 'export': exportProfiles(); break
      case 'close-tab': if (tab) closeTab(tab.id); break
      case 'copy': copySelection(); break
      case 'paste': pasteClipboard(); break
      case 'select-all': if (tab && tab.view) tab.view.selectAll(); break
      case 'search': toggleSearch(); break
      case 'clear': if (tab && tab.view) tab.view.clear(); break
      case 'zoom-in': setFontSize(state.settings.fontSize + 1); break
      case 'zoom-out': setFontSize(state.settings.fontSize - 1); break
      case 'zoom-reset': setFontSize(13); break
      case 'toggle-theme': setTheme(state.settings.theme === 'dark' ? 'light' : 'dark'); break
      case 'toggle-sftp': setSftpVisible(!state.settings.sftpVisible); break
      case 'toggle-sidebar': setSidebarVisible(!state.settings.sidebarVisible); break
      case 'settings': openSettings(); break
      case 'about': openAbout(); break
    }
  }

  document.addEventListener('DOMContentLoaded', boot)
})()
