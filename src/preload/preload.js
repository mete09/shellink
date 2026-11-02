'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const EVENT_CHANNELS = new Set([
  'session:data',
  'session:status',
  'session:exit',
  'session:prompt',
  'session:prompt-cancel',
  'sftp:progress',
  'menu:action',
  'cli:open'
])

function on (channel, handler) {
  if (!EVENT_CHANNELS.has(channel)) throw new Error('非法事件通道: ' + channel)
  const wrapped = (event, ...args) => handler(...args)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('api', {
  /* 初始化 */
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  /* 配置 */
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  saveProfile: (profile) => ipcRenderer.invoke('profile:save', profile),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
  exportProfiles: () => ipcRenderer.invoke('profile:export'),
  importProfiles: () => ipcRenderer.invoke('profile:import'),
  importSshConfig: () => ipcRenderer.invoke('profile:import-ssh-config'),

  /* 会话 */
  openSession: (payload) => ipcRenderer.invoke('session:open', payload),
  closeSession: (id) => ipcRenderer.invoke('session:close', id),
  sendInput: (id, data) => ipcRenderer.invoke('session:input', { id, data }),
  resizeSession: (id, cols, rows) => ipcRenderer.invoke('session:resize', { id, cols, rows }),
  answerPrompt: (id, value) => ipcRenderer.invoke('session:answer', { id, value }),
  testProfile: (profile) => ipcRenderer.invoke('session:test', profile),

  /* 文件传输 */
  sftpHome: (id) => ipcRenderer.invoke('sftp:home', id),
  sftpList: (id, path) => ipcRenderer.invoke('sftp:list', { id, path }),
  sftpMkdir: (id, path) => ipcRenderer.invoke('sftp:mkdir', { id, path }),
  sftpRename: (id, from, to) => ipcRenderer.invoke('sftp:rename', { id, from, to }),
  sftpDelete: (id, path, isDir) => ipcRenderer.invoke('sftp:delete', { id, path, isDir }),
  sftpDownload: (id, remotePath) => ipcRenderer.invoke('sftp:download', { id, remotePath }),
  sftpUpload: (id, remoteDir) => ipcRenderer.invoke('sftp:upload', { id, remoteDir }),

  /* 系统 */
  pickFile: (opts) => ipcRenderer.invoke('dialog:pick-file', opts || {}),
  pickDir: (opts) => ipcRenderer.invoke('dialog:pick-dir', opts || {}),
  copyText: (text) => ipcRenderer.invoke('app:copy', text),
  pasteText: () => ipcRenderer.invoke('app:paste'),
  homeDir: () => ipcRenderer.invoke('app:home-dir'),
  confirmClose: (count) => ipcRenderer.invoke('app:confirm-close', { count }),

  /* 事件 */
  on
})
