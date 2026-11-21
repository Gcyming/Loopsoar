# 校验安装包/主程序 Authenticode 签名（发布门 §6.1）。
# 用法：powershell -File scripts/verify-signature.ps1 release\dist\Loopsoar-Setup-0.0.1.exe
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Path)) { Write-Error "文件不存在：$Path"; exit 2 }
$sig = Get-AuthenticodeSignature -FilePath $Path
$signer = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "(none)" }
$stamp = if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { "(no timestamp)" }
[pscustomobject]@{
  File        = (Resolve-Path $Path).Path
  Status      = $sig.Status
  Signer      = $signer
  Timestamp   = $stamp
  Valid       = ($sig.Status -eq "Valid")
} | Format-List
if ($sig.Status -ne "Valid") { exit 1 }
