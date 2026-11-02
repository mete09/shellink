/* 连接编辑对话框 */
window.SP = window.SP || {}

SP.openProfileEditor = function ({ profile, shells, onSave, onDelete }) {
  const isNew = !profile.id
  const p = {
    id: '',
    type: 'ssh',
    name: '',
    group: '',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    password: '',
    privateKeyPath: '',
    privateKey: '',
    privateKeyPass: '',
    keepalive: 30,
    timeout: 20,
    autoReconnect: true,
    initCommand: '',
    cwd: '',
    local: null,
    ...profile
  }

  const shellOptions = shells.map(s =>
    `<option value="${SP.esc(s.id)}" ${p.local && p.local.id === s.id ? 'selected' : ''}>${SP.esc(s.name)}</option>`
  ).join('')

  const typeSeg = `
    <div class="segmented" data-seg="type">
      <button data-value="ssh" class="${p.type === 'ssh' ? 'on' : ''}">SSH 服务器</button>
      <button data-value="local" class="${p.type === 'local' ? 'on' : ''}">本地终端</button>
    </div>`

  const body = `
    <div class="field">
      <label>连接类型</label>
      ${typeSeg}
    </div>

    <div data-pane="common">
      <div class="field-row">
        <div class="field">
          <label>名称</label>
          <input class="input" data-f="name" value="${SP.esc(p.name)}" placeholder="例如：生产环境 Web-01" />
        </div>
        <div class="field" style="max-width:170px">
          <label>分组</label>
          <input class="input" data-f="group" value="${SP.esc(p.group)}" placeholder="可选" />
        </div>
      </div>
    </div>

    <div data-pane="ssh">
      <div class="field-row">
        <div class="field" style="flex:3">
          <label>主机地址</label>
          <input class="input" data-f="host" value="${SP.esc(p.host)}" placeholder="192.168.1.10 或 example.com" spellcheck="false" />
        </div>
        <div class="field" style="flex:1;max-width:110px">
          <label>端口</label>
          <input class="input" data-f="port" value="${SP.esc(p.port)}" placeholder="22" />
        </div>
      </div>

      <div class="field">
        <label>用户名</label>
        <input class="input" data-f="username" value="${SP.esc(p.username)}" placeholder="root" spellcheck="false" />
      </div>

      <div class="field">
        <label>认证方式</label>
        <div class="segmented" data-seg="auth">
          <button data-value="password" class="${p.authType === 'password' ? 'on' : ''}">密码</button>
          <button data-value="key" class="${p.authType === 'key' ? 'on' : ''}">私钥</button>
          <button data-value="agent" class="${p.authType === 'agent' ? 'on' : ''}">SSH Agent</button>
        </div>
      </div>

      <div class="field" data-auth="password">
        <label>密码</label>
        <input class="input" type="password" data-f="password" value="${SP.esc(p.password)}" placeholder="保存在系统级加密存储中" />
      </div>

      <div data-auth="key">
        <div class="field">
          <label>私钥文件</label>
          <div class="input-group">
            <input class="input" data-f="privateKeyPath" value="${SP.esc(p.privateKeyPath)}" placeholder="C:\\Users\\you\\.ssh\\id_rsa" spellcheck="false" />
            <button class="btn btn-ghost" data-act="pick-key">浏览</button>
          </div>
          <div class="hint">支持 OpenSSH / PEM 格式，例如 id_rsa、id_ed25519。</div>
        </div>
        <div class="field">
          <label>或直接粘贴私钥内容</label>
          <textarea class="textarea" data-f="privateKey" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----">${SP.esc(p.privateKey)}</textarea>
        </div>
        <div class="field">
          <label>私钥口令（可选）</label>
          <input class="input" type="password" data-f="privateKeyPass" value="${SP.esc(p.privateKeyPass)}" placeholder="私钥未加密则留空" />
        </div>
      </div>
    </div>

    <div data-pane="local">
      <div class="field">
        <label>Shell 程序</label>
        <select class="select" data-f="shellId">${shellOptions}</select>
      </div>
      <div class="field">
        <label>起始目录（可选）</label>
        <div class="input-group">
          <input class="input" data-f="cwd" value="${SP.esc(p.cwd || '')}" placeholder="默认为用户主目录" spellcheck="false" />
          <button class="btn btn-ghost" data-act="pick-dir">浏览</button>
        </div>
      </div>
    </div>

    <button class="adv-toggle" data-act="adv-toggle" type="button">
      ${SP.icon('chevron', 12, 'chev')}
      <span>高级选项</span>
      <span class="adv-summary">心跳 / 超时 / 登录后执行</span>
    </button>
    <div class="adv-body hidden" data-pane="ssh-adv">
      <div class="field-row">
        <div class="field">
          <label>心跳间隔（秒）</label>
          <input class="input" data-f="keepalive" value="${SP.esc(p.keepalive)}" placeholder="30" />
        </div>
        <div class="field">
          <label>连接超时（秒）</label>
          <input class="input" data-f="timeout" value="${SP.esc(p.timeout)}" placeholder="20" />
        </div>
      </div>
      <div class="field">
        <label>登录后自动执行（可选）</label>
        <input class="input" data-f="initCommand" value="${SP.esc(p.initCommand || '')}" placeholder="例如：cd /var/log && tail -f app.log" spellcheck="false" />
      </div>
      <div class="field" style="margin-bottom:4px">
        <label class="checkbox"><input type="checkbox" data-f="autoReconnect" ${p.autoReconnect ? 'checked' : ''} /> 连接异常断开时自动重连</label>
      </div>
    </div>
  `

  const foot = SP.el('div', '')
  foot.style.cssText = 'display:flex;gap:8px;width:100%;align-items:center'
  foot.innerHTML = `
    <button class="btn btn-ghost btn-sm" data-act="test">${SP.icon('plug', 13)}<span>测试连接</span></button>
    <span class="test-result" style="margin-left:2px"></span>
    <span style="flex:1"></span>
    ${!isNew && onDelete ? `<button class="btn btn-danger btn-sm" data-act="delete">删除</button>` : ''}
    <button class="btn btn-ghost" data-act="cancel">取消</button>
    <button class="btn btn-primary" data-act="save">${isNew ? '创建' : '保存'}</button>
  `

  let currentType = p.type
  let currentAuth = p.authType || 'password'

  const modal = SP.modal({
    title: isNew ? '新建连接' : '编辑连接',
    body,
    footer: foot,
    width: 600,
    onMount: (m) => {
      const q = (sel) => m.body.querySelector(sel)
      const qa = (sel) => Array.from(m.body.querySelectorAll(sel))

      const sync = () => {
        qa('[data-pane="ssh"]').forEach(n => n.classList.toggle('hidden', currentType !== 'ssh'))
        const advBody = m.body.querySelector('.adv-body')
        if (advBody) advBody.classList.toggle('off', currentType !== 'ssh')
        qa('[data-pane="local"]').forEach(n => n.classList.toggle('hidden', currentType !== 'local'))
        qa('[data-auth]').forEach(n => n.classList.toggle('hidden', n.dataset.auth !== currentAuth))
        const advBtn = m.body.querySelector('[data-act="adv-toggle"]')
        if (advBtn) advBtn.classList.toggle('hidden', currentType !== 'ssh')
        if (currentType !== 'ssh') {
          foot.querySelector('[data-act="test"]').style.display = 'none'
        } else {
          foot.querySelector('[data-act="test"]').style.display = ''
        }
      }

      const advBtnEl = m.body.querySelector('[data-act="adv-toggle"]')
      const advBodyEl = m.body.querySelector('.adv-body')
      if (advBtnEl && advBodyEl) {
        advBtnEl.addEventListener('click', () => {
          const nowHidden = advBodyEl.classList.toggle('hidden')
          advBtnEl.classList.toggle('open', !nowHidden)
        })
      }

      m.body.querySelector('[data-seg="type"]').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]')
        if (!btn) return
        currentType = btn.dataset.value
        SP.$$('[data-seg="type"] button', m.body).forEach(b => b.classList.toggle('on', b === btn))
        sync()
      })

      m.body.querySelector('[data-seg="auth"]').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]')
        if (!btn) return
        currentAuth = btn.dataset.value
        SP.$$('[data-seg="auth"] button', m.body).forEach(b => b.classList.toggle('on', b === btn))
        sync()
      })

      m.body.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]')
        if (!btn) return
        if (btn.dataset.act === 'pick-key') {
          const picked = await window.api.pickFile({
            title: '选择私钥文件',
            filters: [{ name: '私钥', extensions: ['*'] }]
          })
          if (picked) q('[data-f="privateKeyPath"]').value = picked
        }
        if (btn.dataset.act === 'pick-dir') {
          const picked = await window.api.pickDir({ title: '选择起始目录' })
          if (picked) q('[data-f="cwd"]').value = picked
        }
      })

      const collect = () => {
        const val = (f) => {
          const node = q(`[data-f="${f}"]`)
          if (!node) return undefined
          if (node.type === 'checkbox') return node.checked
          return node.value
        }
        const shellId = val('shellId')
        const shellInfo = shells.find(s => s.id === shellId) || shells[0] || null
        const next = {
          ...p,
          type: currentType,
          name: (val('name') || '').trim(),
          group: (val('group') || '').trim(),
          host: (val('host') || '').trim(),
          port: Number(val('port')) || 22,
          username: (val('username') || '').trim(),
          authType: currentAuth,
          password: val('password') || '',
          privateKeyPath: (val('privateKeyPath') || '').trim(),
          privateKey: val('privateKey') || '',
          privateKeyPass: val('privateKeyPass') || '',
          keepalive: Number(val('keepalive')) || 0,
          timeout: Number(val('timeout')) || 20,
          autoReconnect: !!val('autoReconnect'),
          initCommand: val('initCommand') || '',
          cwd: val('cwd') || '',
          local: shellInfo
            ? { id: shellInfo.id, name: shellInfo.name, shell: shellInfo.shell, args: shellInfo.args }
            : p.local
        }
        if (!next.name) {
          next.name = next.type === 'ssh' ? (next.host || 'SSH 连接') : (next.local ? next.local.name : '本地终端')
        }
        return next
      }

      const testBtn = foot.querySelector('[data-act="test"]')
      const resultEl = foot.querySelector('.test-result')
      testBtn.addEventListener('click', async () => {
        const data = collect()
        if (!data.host) return SP.toast('请先填写主机地址', 'err')
        testBtn.disabled = true
        resultEl.className = 'test-result'
        resultEl.textContent = '测试中…'
        const res = await window.api.testProfile(data)
        testBtn.disabled = false
        resultEl.className = 'test-result ' + (res.ok ? 'ok' : 'err')
        resultEl.innerHTML = `${SP.icon(res.ok ? 'check' : 'alert', 13)}<span>${SP.esc(res.message)}</span>`
      })

      foot.querySelector('[data-act="cancel"]').onclick = () => m.close(null)
      foot.querySelector('[data-act="save"]').onclick = async () => {
        const data = collect()
        if (data.type === 'ssh' && !data.host) return SP.toast('请填写主机地址', 'err')
        if (data.type === 'local' && !data.local) return SP.toast('没有检测到可用的 Shell', 'err')
        await onSave(data)
        m.close(data)
      }
      const delBtn = foot.querySelector('[data-act="delete"]')
      if (delBtn) {
        delBtn.onclick = async () => {
          const ok = await SP.confirm({
            title: '删除连接',
            message: `确定要删除连接 “${p.name}” 吗？`,
            okText: '删除',
            danger: true
          })
          if (ok) {
            await onDelete(p)
            m.close(null)
          }
        }
      }

      sync()
      setTimeout(() => {
        const first = m.body.querySelector(currentType === 'ssh' ? '[data-f="host"]' : '[data-f="name"]')
        if (first) { first.focus(); if (first.value) first.select() }
      }, 40)
    }
  })
  return modal
}
