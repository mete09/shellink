/* 右侧文件面板（SFTP） */
window.SP = window.SP || {}

SP.FilePanel = class FilePanel {
  constructor () {
    this.root = document.getElementById('sftp')
    this.sessionId = null
    this.cwd = null
    this.items = []
    this.busy = false
    this._progressTimer = null
    this._lastPath = new Map()
    this._build()
  }

  _build () {
    this.root.innerHTML = `
      <div class="sftp-head">
        <button class="icon-btn" data-act="up" title="上级目录">${SP.icon('arrowUp', 15)}</button>
        <input class="sftp-path" spellcheck="false" placeholder="/" />
        <button class="icon-btn" data-act="refresh" title="刷新">${SP.icon('refresh', 15)}</button>
      </div>
      <div class="sftp-toolbar">
        <button class="btn btn-sm btn-ghost" data-act="upload">${SP.icon('upload', 13)}<span>上传</span></button>
        <button class="btn btn-sm btn-ghost" data-act="mkdir">${SP.icon('folder', 13)}<span>新建文件夹</span></button>
        <button class="btn btn-sm btn-ghost" data-act="download" disabled>${SP.icon('download', 13)}<span>下载</span></button>
      </div>
      <div class="sftp-list"></div>
      <div class="sftp-foot">
        <span class="sftp-msg">未连接</span>
        <div class="progress-track"><div class="progress-bar"></div></div>
      </div>
    `
    this.pathInput = this.root.querySelector('.sftp-path')
    this.listEl = this.root.querySelector('.sftp-list')
    this.msgEl = this.root.querySelector('.sftp-msg')
    this.trackEl = this.root.querySelector('.progress-track')
    this.barEl = this.root.querySelector('.progress-bar')
    this.downloadBtn = this.root.querySelector('[data-act="download"]')

    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = this.pathInput.value.trim()
        if (v) this.load(v)
        this.pathInput.blur()
      }
      if (e.key === 'Escape') {
        this.pathInput.value = this.cwd || '/'
        this.pathInput.blur()
      }
    })

    this.root.querySelector('.sftp-head').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]')
      if (!btn) return
      const act = btn.dataset.act
      if (act === 'up' && this.cwd) this.load(this.parentOf(this.cwd))
      if (act === 'refresh') this.load(this.cwd)
    })

    this.root.querySelector('.sftp-toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]')
      if (!btn) return
      const act = btn.dataset.act
      if (act === 'upload') this.upload()
      if (act === 'mkdir') this.mkdir()
      if (act === 'download') this.downloadSelected()
    })
  }

  parentOf (p) {
    if (!p || p === '/') return '/'
    const parts = p.split('/').filter(Boolean)
    parts.pop()
    return '/' + parts.join('/')
  }

  setVisible (visible) {
    this.root.classList.toggle('visible', !!visible)
    if (visible) this.refreshForActive()
  }

  async attach (tab) {
    if (!tab) {
      this.sessionId = null
      this.showPlaceholder('未打开会话')
      return
    }
    if (tab.profile.type !== 'ssh') {
      this.sessionId = null
      this.showPlaceholder('本地终端无需文件传输')
      return
    }
    if (this.sessionId === tab.sessionId && this.cwd) return
    this.sessionId = tab.sessionId
    const cached = this._lastPath.get(tab.sessionId)
    try {
      if (cached) {
        await this.load(cached)
      } else {
        const { path } = await window.api.sftpHome(tab.sessionId)
        await this.load(path)
      }
    } catch (e) {
      this.showPlaceholder(e.message || '无法打开 SFTP')
    }
  }

  refreshForActive () {
    if (!this.root.classList.contains('visible')) return
    if (this.sessionId && this.cwd) this.load(this.cwd)
  }

  showPlaceholder (text) {
    this.listEl.innerHTML = `<div class="empty-hint">${SP.esc(text)}</div>`
    this.msgEl.textContent = ''
    this.trackEl.classList.remove('on')
    this.pathInput.value = ''
    this.cwd = null
  }

  async load (path) {
    if (!this.sessionId || this.busy) return
    this.busy = true
    this.msgEl.textContent = '加载中…'
    try {
      const res = await window.api.sftpList(this.sessionId, path || '.')
      this.cwd = res.path
      this.items = res.items
      this.pathInput.value = res.path
      this._lastPath.set(this.sessionId, res.path)
      this.renderList()
      const dirs = res.items.filter(i => i.isDir).length
      this.msgEl.textContent = `${res.items.length} 项 · ${dirs} 个文件夹`
    } catch (e) {
      this.listEl.innerHTML = `<div class="empty-hint" style="color:var(--red)">${SP.esc(e.message || '读取失败')}</div>`
      this.msgEl.textContent = '读取失败'
    } finally {
      this.busy = false
    }
  }

  renderList () {
    if (!this.items.length) {
      this.listEl.innerHTML = '<div class="empty-hint">空目录</div>'
      return
    }
    const frag = document.createDocumentFragment()
    for (const item of this.items) {
      const row = SP.el('div', 'sftp-row' + (item.isDir ? ' dir' : ''))
      row.innerHTML = `
        <span class="f-icon">${SP.icon(item.isDir ? 'folder' : 'file', 15)}</span>
        <span class="f-name" title="${SP.esc(item.name)}">${SP.esc(item.name)}</span>
        <span class="f-size">${SP.esc(item.sizeText)}</span>
        <span class="row-del" title="删除">${SP.icon('trash', 12)}</span>
      `
      row.addEventListener('click', () => {
        SP.$$('.sftp-row', this.listEl).forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        row.style.background = 'var(--accent-soft)'
        this.selected = item
        this.downloadBtn.disabled = false
      })
      row.addEventListener('dblclick', () => {
        if (item.isDir) this.load(item.path)
        else this.download(item)
      })
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        SP.openMenu(e.clientX, e.clientY, [
          { label: item.isDir ? '进入目录' : '下载到本地…', icon: item.isDir ? 'folder' : 'download', onClick: () => (item.isDir ? this.load(item.path) : this.download(item)) },
          { label: '重命名…', icon: 'edit', onClick: () => this.rename(item) },
          { sep: true },
          { label: '删除', icon: 'trash', danger: true, onClick: () => this.remove(item) }
        ])
      })
      row.querySelector('.row-del').addEventListener('click', (e) => {
        e.stopPropagation()
        this.remove(item)
      })
      frag.appendChild(row)
    }
    this.listEl.innerHTML = ''
    this.listEl.appendChild(frag)
    this.selected = null
    this.downloadBtn.disabled = true
  }

  async download (item) {
    if (!this.sessionId) return
    this.showProgress(`正在下载 ${item.name}…`, 0)
    try {
      const res = await window.api.sftpDownload(this.sessionId, item.path)
      if (res && res.ok) {
        SP.toast(`已下载到 ${res.target}`, 'ok', 3200)
      }
    } catch (e) {
      SP.toast(e.message || '下载失败', 'err', 4000)
    } finally {
      this.hideProgress()
    }
  }

  downloadSelected () {
    if (this.selected) this.download(this.selected)
  }

  async upload () {
    if (!this.sessionId || !this.cwd) return
    try {
      const res = await window.api.sftpUpload(this.sessionId, this.cwd)
      if (res && res.ok) {
        SP.toast(`已上传 ${res.uploaded.length} 个文件`, 'ok')
        this.load(this.cwd)
      }
    } catch (e) {
      SP.toast(e.message || '上传失败', 'err', 4000)
    } finally {
      this.hideProgress()
    }
  }

  async mkdir () {
    if (!this.sessionId || !this.cwd) return
    const name = await SP.prompt({ title: '新建文件夹', label: '文件夹名称', placeholder: 'new-folder' })
    if (!name) return
    try {
      await window.api.sftpMkdir(this.sessionId, this.cwd.replace(/\/$/, '') + '/' + name)
      this.load(this.cwd)
    } catch (e) {
      SP.toast(e.message || '创建失败', 'err', 4000)
    }
  }

  async rename (item) {
    const name = await SP.prompt({ title: '重命名', label: '新名称', value: item.name })
    if (!name || name === item.name) return
    try {
      const to = this.cwd.replace(/\/$/, '') + '/' + name
      await window.api.sftpRename(this.sessionId, item.path, to)
      this.load(this.cwd)
    } catch (e) {
      SP.toast(e.message || '重命名失败', 'err', 4000)
    }
  }

  async remove (item) {
    const ok = await SP.confirm({
      title: '删除确认',
      message: `确定要删除${item.isDir ? '文件夹' : '文件'} “${item.name}” 吗？此操作不可撤销。`,
      okText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      await window.api.sftpDelete(this.sessionId, item.path, item.isDir)
      this.load(this.cwd)
    } catch (e) {
      SP.toast(e.message || '删除失败', 'err', 4000)
    }
  }

  showProgress (text, ratio) {
    this.msgEl.textContent = text
    this.trackEl.classList.add('on')
    this.barEl.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%'
  }

  onProgress ({ op, file, transferred, total }) {
    const ratio = total ? transferred / total : 0
    const label = op === 'download' ? '下载' : '上传'
    this.showProgress(`${label} ${file} · ${Math.round(ratio * 100)}%`, ratio)
    clearTimeout(this._progressTimer)
    this._progressTimer = setTimeout(() => this.hideProgress(), 1500)
  }

  hideProgress () {
    this.trackEl.classList.remove('on')
    this.barEl.style.width = '0%'
    if (this.cwd) {
      this.msgEl.textContent = `${this.items.length} 项`
    }
  }
}
