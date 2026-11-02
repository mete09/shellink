'use strict'
/**
 * 本地 Shell 探测：Windows PowerShell / PowerShell 7 / CMD / Git Bash / WSL
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

function exists (p) {
  try { return !!p && fs.existsSync(p) } catch (_) { return false }
}

function envPath (...parts) {
  return path.join(...parts)
}

function detectShells () {
  const list = []
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localApp = process.env.LOCALAPPDATA || envPath(os.homedir(), 'AppData', 'Local')

  const pwsh7 = [
    envPath(pf, 'PowerShell', '7', 'pwsh.exe'),
    envPath(pf, 'PowerShell', '7-preview', 'pwsh.exe')
  ].find(exists)
  if (pwsh7) {
    list.push({ id: 'pwsh', name: 'PowerShell 7', shell: pwsh7, args: ['-NoLogo'] })
  }

  const winPs = envPath(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (exists(winPs)) {
    list.push({ id: 'powershell', name: 'Windows PowerShell', shell: winPs, args: ['-NoLogo'] })
  }

  const cmd = envPath(sysRoot, 'System32', 'cmd.exe')
  if (exists(cmd)) {
    list.push({ id: 'cmd', name: '命令提示符', shell: cmd, args: [] })
  }

  const bash = [
    envPath(pf, 'Git', 'bin', 'bash.exe'),
    envPath(pf86, 'Git', 'bin', 'bash.exe'),
    envPath(localApp, 'Programs', 'Git', 'bin', 'bash.exe')
  ].find(exists)
  if (bash) {
    list.push({ id: 'gitbash', name: 'Git Bash', shell: bash, args: ['--login', '-i'] })
  }

  const wsl = envPath(sysRoot, 'System32', 'wsl.exe')
  if (exists(wsl)) {
    list.push({ id: 'wsl', name: 'WSL', shell: wsl, args: [] })
  }

  return list
}

module.exports = { detectShells, exists }
