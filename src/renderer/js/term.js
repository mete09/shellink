/* 终端视图：封装 xterm.js 实例 */
window.SP = window.SP || {}

SP.THEMES = {
  /* 单色（默认）：与界面一致的纯黑白灰层次 */
  light: {
    background: '#ffffff',
    foreground: '#141414',
    cursor: '#141414',
    cursorAccent: '#ffffff',
    selectionBackground: '#e4e4e4',
    black: '#1c1c1c',
    red: '#2b2b2b',
    green: '#3a3a3a',
    yellow: '#484848',
    blue: '#565656',
    magenta: '#636363',
    cyan: '#707070',
    white: '#7d7d7d',
    brightBlack: '#000000',
    brightRed: '#101010',
    brightGreen: '#1f1f1f',
    brightYellow: '#2d2d2d',
    brightBlue: '#3b3b3b',
    brightMagenta: '#494949',
    brightCyan: '#575757',
    brightWhite: '#666666'
  },
  dark: {
    background: '#0c0c0c',
    foreground: '#e8e8e8',
    cursor: '#f5f5f5',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#2b2b2b',
    black: '#1a1a1a',
    red: '#3a3a3a',
    green: '#4a4a4a',
    yellow: '#5a5a5a',
    blue: '#6a6a6a',
    magenta: '#7a7a7a',
    cyan: '#8a8a8a',
    white: '#c8c8c8',
    brightBlack: '#8a8a8a',
    brightRed: '#a0a0a0',
    brightGreen: '#adadad',
    brightYellow: '#bababa',
    brightBlue: '#c6c6c6',
    brightMagenta: '#d0d0d0',
    brightCyan: '#dcdcdc',
    brightWhite: '#f4f4f4'
  },
  /* 彩色（可选）：需要靠颜色区分日志级别时开启 */
  'light-color': {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#24292f',
    cursorAccent: '#ffffff',
    selectionBackground: '#dcdcdc',
    black: '#24292f',
    red: '#b42318',
    green: '#116329',
    yellow: '#7a5c00',
    blue: '#0550ae',
    magenta: '#8250df',
    cyan: '#0f6f7e',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#8a6d00',
    brightBlue: '#0969da',
    brightMagenta: '#a475f9',
    brightCyan: '#1b7c83',
    brightWhite: '#8c959f'
  },
  'dark-color': {
    background: '#0c0c0c',
    foreground: '#d8dde5',
    cursor: '#f0f0f0',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#333333',
    black: '#1a1a1a',
    red: '#f2777a',
    green: '#7ec699',
    yellow: '#f2c97d',
    blue: '#7fa8ff',
    magenta: '#c39ac9',
    cyan: '#78ccf0',
    white: '#c8ced8',
    brightBlack: '#5a6272',
    brightRed: '#ff8b8f',
    brightGreen: '#a3e4b8',
    brightYellow: '#ffd88f',
    brightBlue: '#a8c0ff',
    brightMagenta: '#d9b3df',
    brightCyan: '#9ce1ff',
    brightWhite: '#eef1f5'
  }
}

SP.terminalTheme = function (theme, colorful) {
  const key = colorful ? (theme === 'dark' ? 'dark-color' : 'light-color') : (theme === 'dark' ? 'dark' : 'light')
  return SP.THEMES[key] || SP.THEMES.light
}

SP.TerminalView = class TerminalView {
  constructor ({ sessionId, settings, onResize }) {
    this.sessionId = sessionId
    this.settings = settings
    this.onResizeCb = onResize || null
    this.disposed = false
    this._fitTimer = null

    this.wrap = document.createElement('div')
    this.wrap.className = 'term-wrap'

    this.term = new window.Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: 1.32,
      letterSpacing: 0,
      cursorBlink: settings.cursorBlink !== false,
      cursorStyle: 'bar',
      scrollback: settings.scrollback || 8000,
      allowProposedApi: true,
      theme: SP.terminalTheme(settings.theme, settings.colorTerminal),
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      smoothScrollDuration: 90,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1
    })

    this.fitAddon = new window.FitAddon.FitAddon()
    this.term.loadAddon(this.fitAddon)
    try {
      this.searchAddon = new window.SearchAddon.SearchAddon({ highlightSelectionMatches: true })
      this.term.loadAddon(this.searchAddon)
    } catch (_) {}
    try {
      this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((event, uri) => {
        window.open(uri)
      }))
    } catch (_) {}

    this.term.onData(data => window.api.sendInput(this.sessionId, data))
    this.term.onResize(({ cols, rows }) => {
      window.api.resizeSession(this.sessionId, cols, rows)
      if (this.onResizeCb) this.onResizeCb(cols, rows)
    })

    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const ctrlShift = (e.ctrlKey || e.metaKey) && e.shiftKey
      if (ctrlShift && e.code === 'KeyC') {
        const sel = this.term.getSelection()
        if (sel) window.api.copyText(sel)
        return false
      }
      if (ctrlShift && e.code === 'KeyV') {
        window.api.pasteText().then(text => {
          if (text) this.term.paste(text)
        })
        return false
      }
      if (ctrlShift && e.code === 'KeyA') {
        this.term.selectAll()
        return false
      }
      return true
    })

    this._ro = new ResizeObserver(() => this.fit())
    this._ro.observe(this.wrap)
  }

  mount (parent) {
    parent.appendChild(this.wrap)
    this.term.open(this.wrap)
    this.fit()
    this.focus()
  }

  write (chunk) {
    if (!this.disposed) this.term.write(chunk)
  }

  writeln (text) {
    this.term.writeln(text)
  }

  fit () {
    if (this.disposed || !this.wrap.isConnected) return
    if (!this.wrap.clientWidth || !this.wrap.clientHeight) return
    clearTimeout(this._fitTimer)
    this._fitTimer = setTimeout(() => {
      try { this.fitAddon.fit() } catch (_) {}
    }, 16)
  }

  focus () {
    if (!this.disposed) {
      try { this.term.focus() } catch (_) {}
    }
  }

  getSelection () { return this.term.getSelection() }
  hasSelection () { return this.term.hasSelection() }
  selectAll () { this.term.selectAll() }
  clear () { this.term.clear() }
  reset () { try { this.term.reset() } catch (_) {} }

  paste (text) {
    if (text) this.term.paste(text)
  }

  setFontSize (size) {
    this.term.options.fontSize = size
    this.fit()
  }

  setTheme (theme, colorful) {
    this.term.options.theme = SP.terminalTheme(theme, colorful)
  }

  setActive (active) {
    this.wrap.classList.toggle('active', active)
    if (active) {
      this.fit()
      this.focus()
    }
  }

  findNext (text, opts = {}) {
    if (!this.searchAddon || !text) return
    this.searchAddon.findNext(text, { incremental: true, ...opts })
  }

  findPrev (text, opts = {}) {
    if (!this.searchAddon || !text) return
    this.searchAddon.findPrevious(text, { incremental: true, ...opts })
  }

  clearSearch () {
    if (!this.searchAddon) return
    this.searchAddon.clearDecorations()
    this.focus()
  }

  dispose () {
    this.disposed = true
    try { this._ro.disconnect() } catch (_) {}
    try { this.term.dispose() } catch (_) {}
    this.wrap.remove()
  }
}
