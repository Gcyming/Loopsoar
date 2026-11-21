; installer.nsh — Loopsoar 安装向导自定义选项（electron-builder nsis.include）
;
; 1) 在选择安装目录之后追加「安装选项」页：
;    · 创建桌面快捷方式（默认勾选）
;    · 开机自动启动 Loopsoar（默认不勾选）
;    桌面快捷方式的唯一产地在本文件：electron-builder.yml 的 createDesktopShortcut
;    必须保持 false，否则二值选项会和这里的勾选冲突（取消后仍被创建）。
; 2) 卸载欢迎页改为勾选页：让用户选择是否删除用户数据（默认保留）。
;    静默卸载（/S）不显示页面，按「保留数据」处理。
; 3) 卸载时清理开机自启项与桌面快捷方式；仅在用户勾选时删除数据目录。

!include "nsDialogs.nsh"

Var loopsoarDesktopCheck
Var loopsoarAutostartCheck
!ifdef BUILD_UNINSTALLER
Var loopsoarDeleteDataCheck
Var loopsoarDeleteData
!endif

!macro customPageAfterChangeDir
  Page custom loopsoarOptionsPage loopsoarOptionsLeave
!macroend

!macro customUnWelcomePage
  UninstPage custom un.loopsoarUninstallPage un.loopsoarUninstallLeave
!macroend

; 静默安装不会执行上面的自定义页，这里补默认的桌面快捷方式（与页面默认值一致）。
!macro customInstall
  IfSilent 0 loopsoarInstallSkipShortcut
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  loopsoarInstallSkipShortcut:
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  ${if} $loopsoarDeleteData == "1"
    ; 默认数据目录：%APPDATA%\loopsoar；缓存目录：%LOCALAPPDATA%\loopsoar。
    ; 若用户用 LOOPSOAR_DATA_DIR 指向自定义目录，安装器无法得知，需用户手动删除。
    RMDir /r "$APPDATA\loopsoar"
    RMDir /r "$LOCALAPPDATA\loopsoar"
  ${endif}
!macroend

; NSIS 不把 Page custom 注册计为函数引用，会报 warning 6010；electron-builder 以 -WX 编译。
!pragma warning disable 6010
Function loopsoarOptionsPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 20u "安装选项"
  ${NSD_CreateCheckbox} 0 30u 100% 30u "创建桌面快捷方式"
  Pop $loopsoarDesktopCheck
  ${NSD_Check} $loopsoarDesktopCheck
  ${NSD_CreateCheckbox} 0 70u 100% 30u "开机自动启动 Loopsoar（最小化到托盘运行）"
  Pop $loopsoarAutostartCheck
  ${NSD_CreateLabel} 0 110u 100% 40u "Loopsoar 内测版不需要管理员权限，安装到当前用户目录即可。$\r$\n之后可在设置中关闭开机自启或删除桌面快捷方式。"
  nsDialogs::Show
FunctionEnd

Function loopsoarOptionsLeave
  ${NSD_GetState} $loopsoarDesktopCheck $0
  StrCmp $0 ${BST_CHECKED} 0 +3
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  Goto +2
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

  ${NSD_GetState} $loopsoarAutostartCheck $0
  StrCmp $0 ${BST_CHECKED} 0 +3
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}" '"$INSTDIR\${PRODUCT_NAME}.exe"'
  Goto +2
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
FunctionEnd
!pragma warning default 6010

!ifdef BUILD_UNINSTALLER
Function un.loopsoarUninstallPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "卸载 ${PRODUCT_NAME} 前，请选择如何处理用户数据："
  ${NSD_CreateCheckbox} 0 32u 100% 30u "删除用户数据（API 密钥、会话、记忆、规则、设置）"
  Pop $loopsoarDeleteDataCheck
  ${NSD_CreateLabel} 0 72u 100% 60u "默认保留数据，重新安装后可继续使用。$\r$\n勾选将删除 %APPDATA%\loopsoar 与 %LOCALAPPDATA%\loopsoar，且不可恢复。$\r$\n如使用自定义数据目录（LOOPSOAR_DATA_DIR），请自行删除。"
  nsDialogs::Show
FunctionEnd

Function un.loopsoarUninstallLeave
  StrCpy $loopsoarDeleteData "0"
  ${NSD_GetState} $loopsoarDeleteDataCheck $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $loopsoarDeleteData "1"
  ${EndIf}
FunctionEnd
!endif
