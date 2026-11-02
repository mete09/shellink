# Maintain the Shellink install folder inside the current user's PATH so that
# the "shlnk" command works from any terminal.
# Only HKCU\Environment\Path is touched, and the original value kind
# (REG_SZ / REG_EXPAND_SZ) is preserved so %VAR% entries keep expanding.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [ValidateSet('install', 'uninstall')][string]$Mode = 'install'
)

$ErrorActionPreference = 'SilentlyContinue'
$keyPath = 'HKCU:\Environment'
$Dir = $Dir.TrimEnd('\')
if ($Dir -eq '') { exit 0 }

$item = Get-Item -Path $keyPath
$raw = ''
$kind = 'ExpandString'
if ($null -ne $item) {
  try { $raw = [string]$item.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } catch { $raw = '' }
  try {
    $k = $item.GetValueKind('Path')
    if ($null -ne $k) { $kind = [string]$k }
  } catch { $kind = 'ExpandString' }
}

$parts = @()
foreach ($p in ($raw -split ';')) {
  $t = $p.Trim()
  if ($t -ne '') { $parts += $t }
}

if ($Mode -eq 'install') {
  if (-not ($parts -contains $Dir)) { $parts += $Dir }
} else {
  $parts = @($parts | Where-Object { $_ -ne $Dir })
}

$new = ($parts -join ';')
Set-ItemProperty -Path $keyPath -Name Path -Value $new -Type $kind

# Tell Explorer the environment changed, so newly opened shells see "shlnk".
try {
  Add-Type -Namespace Shellink -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, int Msg, System.IntPtr wParam, string lParam, int fuFlags, int uTimeout, out System.IntPtr lpdwResult);
'@
  $out = [System.IntPtr]::Zero
  [Shellink.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.IntPtr]::Zero, 'Environment', 2, 3000, [ref]$out) | Out-Null
} catch {
  # Broadcasting is best effort; the PATH entry is already written.
}

exit 0
