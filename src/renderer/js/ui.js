/* 通用 UI 组件：toast / 菜单 / 弹窗 */
window.SP = window.SP || {}

SP.esc = function (s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

SP.$ = (sel, root = document) => root.querySelector(sel)
SP.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

SP.el = function (tag, cls, html) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html !== undefined) n.innerHTML = html
  return n
}

/* ------------------------------------------------------------------ toast */
SP.toast = function (message, type = 'info', ms = 2600) {
  const wrap = document.getElementById('toasts')
  const iconName = type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'terminal'
  const node = SP.el('div', 'toast ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : ''))
  node.innerHTML = `<span class="ti ${type}">${SP.icon(iconName, 15)}</span><span>${SP.esc(message)}</span>`
  wrap.appendChild(node)
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s'
    node.style.opacity = '0'
    node.style.transform = 'translateY(6px)'
    setTimeout(() => node.remove(), 220)
  }, ms)
  return node
}

/* ------------------------------------------------------------------ 菜单 */
let activeMenu = null
let menuHandlers = null

SP.closeMenu = function () {
  if (menuHandlers) {
    document.removeEventListener('mousedown', menuHandlers.down, true)
    document.removeEventListener('keydown', menuHandlers.key, true)
    menuHandlers = null
  }
  if (activeMenu) {
    activeMenu.remove()
    activeMenu = null
  }
}

SP.openMenu = function (x, y, items) {
  SP.closeMenu()
  const menu = SP.el('div', 'menu')
  for (const it of items) {
    if (it.sep) {
      menu.appendChild(SP.el('div', 'menu-sep'))
      continue
    }
    const row = SP.el('div', 'menu-item' + (it.danger ? ' danger' : ''))
    row.innerHTML = `${it.icon ? SP.icon(it.icon, 14) : '<span style="width:14px"></span>'}<span>${SP.esc(it.label)}</span>${it.shortcut ? `<span class="shortcut">${SP.esc(it.shortcut)}</span>` : ''}`
    row.addEventListener('click', () => {
      SP.closeMenu()
      it.onClick && it.onClick()
    })
    menu.appendChild(row)
  }
  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  const px = Math.min(x, window.innerWidth - rect.width - 8)
  const py = Math.min(y, window.innerHeight - rect.height - 8)
  menu.style.left = Math.max(6, px) + 'px'
  menu.style.top = Math.max(6, py) + 'px'
  activeMenu = menu
  const onDocDown = (e) => {
    if (!menu.contains(e.target)) SP.closeMenu()
  }
  const onEsc = (e) => {
    if (e.key === 'Escape') SP.closeMenu()
  }
  menuHandlers = { down: onDocDown, key: onEsc }
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onEsc, true)
  }, 0)
  return menu
}

/* ------------------------------------------------------------------ 弹窗 */
SP.modal = function ({ title, body, width, footer, onMount }) {
  const layer = document.getElementById('dialogs')
  const overlay = SP.el('div', 'overlay')
  const dialog = SP.el('div', 'dialog')
  if (width) dialog.style.width = width + 'px'
  dialog.innerHTML = `
    <div class="dialog-head">
      <span>${SP.esc(title)}</span>
      <span class="spacer"></span>
      <button class="icon-btn" data-close>${SP.icon('x', 15)}</button>
    </div>
    <div class="dialog-body"></div>
    <div class="dialog-foot"></div>
  `
  const bodyEl = dialog.querySelector('.dialog-body')
  const footEl = dialog.querySelector('.dialog-foot')
  if (typeof body === 'string') bodyEl.innerHTML = body
  else if (body) bodyEl.appendChild(body)
  if (footer) {
    if (typeof footer === 'string') footEl.innerHTML = footer
    else if (footer) footEl.appendChild(footer)
  } else {
    footEl.remove()
  }
  overlay.appendChild(dialog)
  layer.appendChild(overlay)

  const api = {
    overlay,
    dialog,
    body: bodyEl,
    foot: footEl,
    close (value) {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      api.onClose && api.onClose(value)
    }
  }

  function onKey (e) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      api.close(null)
    }
  }
  document.addEventListener('keydown', onKey, true)
  dialog.querySelector('[data-close]').addEventListener('click', () => api.close(null))
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) api.close(null)
  })
  onMount && onMount(api)
  return api
}

SP.confirm = function ({ title, message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise(resolve => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const foot = SP.el('div', '')
    foot.style.cssText = 'display:flex;gap:8px;width:100%;align-items:center'
    foot.innerHTML = `<span class="spacer" style="flex:1"></span>
      <button class="btn btn-ghost" data-cancel>${SP.esc(cancelText)}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${SP.esc(okText)}</button>`
    const m = SP.modal({
      title,
      body: `<div style="font-size:12.8px;line-height:1.65;color:var(--text-2);padding-bottom:6px;white-space:pre-wrap">${SP.esc(message)}</div>`,
      footer: foot,
      width: 420,
      onClose: () => done(false)
    })
    foot.querySelector('[data-cancel]').onclick = () => { m.close(); done(false) }
    foot.querySelector('[data-ok]').onclick = () => { m.close(); done(true) }
    setTimeout(() => foot.querySelector('[data-ok]').focus(), 30)
  })
}

SP.prompt = function ({ title, label, value = '', placeholder = '', okText = '确定', type = 'text' }) {
  return new Promise(resolve => {
    const foot = SP.el('div', '')
    foot.style.cssText = 'display:flex;gap:8px;width:100%;align-items:center'
    foot.innerHTML = `<span style="flex:1"></span>
      <button class="btn btn-ghost" data-cancel>取消</button>
      <button class="btn btn-primary" data-ok>${SP.esc(okText)}</button>`
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const m = SP.modal({
      title,
      body: `<div class="field"><label>${SP.esc(label || '')}</label>
        <input class="input" type="${type}" value="${SP.esc(value)}" placeholder="${SP.esc(placeholder)}" /></div>`,
      footer: foot,
      width: 420,
      onClose: () => done(null)
    })
    const input = m.body.querySelector('input')
    input.focus()
    input.select()
    const submit = () => {
      const v = input.value
      m.close()
      done(v)
    }
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit()
    })
    foot.querySelector('[data-cancel]').onclick = () => { m.close(); done(null) }
    foot.querySelector('[data-ok]').onclick = submit
  })
}
