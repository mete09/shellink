; ---------------------------------------------------------------------------
; Shellink —— 安装器自定义脚本
;   1) 目录页选择磁盘根目录（如 D:\）时，自动补上应用文件夹名
;   2) 安装 / 卸载时维护当前用户 PATH，让 shlnk 命令全局可用
; ---------------------------------------------------------------------------

!macro customInit
  ; 仅当目标目录是盘符根目录时才补目录名，其余情况（默认目录、/D= 参数、
  ; 用户自选子目录）一律保持原样，交给 electron-builder 自带的 instFilesPre 处理
  StrCpy $R0 "$INSTDIR" 1 -1
  StrLen $R1 "$INSTDIR"
  StrCmp $R0 "\" 0 shellink_root_colon
    IntCmp $R1 3 0 shellink_dir_ready shellink_dir_ready
    StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
    Goto shellink_dir_ready
  shellink_root_colon:
  StrCmp $R0 ":" 0 shellink_dir_ready
    IntCmp $R1 2 0 shellink_dir_ready shellink_dir_ready
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  shellink_dir_ready:
!macroend

!macro customInstall
  ; 把安装目录写入当前用户 PATH（脚本内直接读写 HKCU\Environment，无需额外插件）
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli-path.ps1" -Dir "$INSTDIR" -Mode install'
  Pop $0
!macroend

!macro customUnInstall
  ; 卸载时从 PATH 中移除安装目录
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli-path.ps1" -Dir "$INSTDIR" -Mode uninstall'
  Pop $0
!macroend
