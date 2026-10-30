<#
.SYNOPSIS
    USB로 연결한 폰에 Muse Dash 모드 복제본(com.prpr.musedash.mod)을 만들어 설치한다.

.DESCRIPTION
    게임 파일(APK·OBB)은 그 폰에 설치된 정품에서 꺼내 쓴다. 이 스크립트는 게임 파일을 들고 있지 않다.
    1) 폰 확인 → 2) 도구 준비(처음 한 번 다운로드) → 3) 정품 APK 꺼내기 → 4) 패키지명 변경·Gadget 삽입
    → 5) 빌드·서명 → 6) 설치 → 7) OBB 복사(폰 안에서) → 8) mod.js 넣기.
    원본 앱과 세이브는 건드리지 않는다.

.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -Serial R3CR10T2JFA -Adb "C:\Program Files (x86)\Nox\bin\nox_adb.exe"
#>
param(
    # 폰이 여러 대 연결돼 있을 때 고를 기기 (adb devices의 첫 칸)
    [string]$Serial,
    # 복제본 패키지명. 바꾸면 그 이름으로 하나 더 설치된다.
    [string]$Package = "com.prpr.musedash.mod",
    # 쓸 adb 경로. 비우면 PATH → 캐시 → 다운로드 순으로 찾는다.
    [string]$Adb,
    # 넣을 mod.js. 비우면 ..\mod\dist\mod.js → GitHub 릴리스 순.
    [string]$ModJs,
    # 서명 키. 비우면 uber-apk-signer 내장 디버그 키(항상 같은 키라 다음 설치 때도 업데이트된다).
    [string]$Keystore,
    [string]$KeyAlias,
    [string]$KeyPass,
    # OBB 복사를 건너뛴다(이미 넣어 둔 경우).
    [switch]$SkipObb
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # PS 5.1에서 진행바가 다운로드를 수십 배 느리게 만든다
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Source = "com.prpr.musedash"
$VersionCode = "632"
$KnownApkSha256 = "a5fd972bbb89d8ae05ef86669e63458044bf7a64d745c8817cdd567f7b9b0701"   # Play 6.8.0 (632) base.apk
$ReleaseModJs = "https://github.com/magjangin/muse-dash-phone/releases/latest/download/mod.js"

$Root = $PSScriptRoot
$Cache = Join-Path $Root ".cache"
$Work = Join-Path $Root "work"

# 버전·해시를 고정한다. 다른 버전의 Gadget이나 apktool로는 확인하지 않았다.
$Tools = @{
    apktool = @{ File = "apktool_3.0.3.jar"; Sha256 = "dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423"
                 Url = "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar" }
    signer  = @{ File = "uber-apk-signer-1.3.0.jar"; Sha256 = "e1299fd6fcf4da527dd53735b56127e8ea922a321128123b9c32d619bba1d835"
                 Url = "https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar" }
    gadget  = @{ File = "frida-gadget-17.24.3-android-arm64.so.xz"; Sha256 = "c5b86db3569d06769da2b29a80c7a275422c3bb292bd7881ea30566fd2161948"
                 Url = "https://github.com/frida/frida/releases/download/17.24.3/frida-gadget-17.24.3-android-arm64.so.xz" }
    xz      = @{ File = "xz-1.10.jar"; Sha256 = "95c63c1a55b22dd6453890a419cc1a640f790bbf7d8ae82db1e30aefefb08888"
                 Url = "https://repo1.maven.org/maven2/org/tukaani/xz/1.10/xz-1.10.jar" }
}

function Step([string]$message) { Write-Host ""; Write-Host "== $message" -ForegroundColor Cyan }
function Info([string]$message) { Write-Host "   $message" }
function Warn([string]$message) { Write-Host "   [주의] $message" -ForegroundColor Yellow }
function Fail([string]$message) { throw $message }

# 네이티브 명령을 실행하고 실패하면 멈춘다. 출력은 그대로 화면에 보인다.
function Run([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { Fail "명령 실패 (종료 코드 $LASTEXITCODE): $exe $($arguments -join ' ')" }
}

# 표준 출력·오류를 한 문자열로 받는다. PS 5.1은 2>&1을 Stop 모드에서 예외로 바꾸므로 잠시 Continue로.
function Capture([string]$exe, [string[]]$arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { $text = (& $exe @arguments 2>&1 | ForEach-Object { "$_" }) -join "`n" }
    finally { $ErrorActionPreference = $previous }
    return @{ Text = $text; Code = $LASTEXITCODE }
}

function AdbArgs([string[]]$arguments) {
    if ($script:Serial) { return @("-s", $script:Serial) + $arguments }
    return $arguments
}
function AdbRun([string[]]$arguments) { Run $script:AdbExe (AdbArgs $arguments) }
function AdbText([string[]]$arguments) {
    $r = Capture $script:AdbExe (AdbArgs $arguments)
    return $r.Text.Trim()
}
# adb shell 명령의 종료 코드까지 받는다.
function AdbShell([string]$command) { return Capture $script:AdbExe (AdbArgs @("shell", $command)) }

function Get-Tool([string]$name) {
    $tool = $Tools[$name]
    $path = Join-Path $Cache $tool.File
    if (Test-Path $path) {
        if ((Get-FileHash $path -Algorithm SHA256).Hash -eq $tool.Sha256) { return $path }
        Remove-Item $path -Force
    }
    Info "다운로드: $($tool.Url)"
    $part = "$path.part"
    Invoke-WebRequest -Uri $tool.Url -OutFile $part -UseBasicParsing
    $hash = (Get-FileHash $part -Algorithm SHA256).Hash
    if ($hash -ne $tool.Sha256) {
        Remove-Item $part -Force
        Fail "$($tool.File) 해시가 다릅니다 ($hash). 다운로드가 깨졌거나 파일이 바뀌었습니다."
    }
    Move-Item $part $path -Force
    return $path
}

function Find-Java {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += Join-Path $env:JAVA_HOME "bin\java.exe" }
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    foreach ($c in $candidates) {
        if (-not (Test-Path $c)) { continue }
        $v = (Capture $c @("-version")).Text
        if ($v -match 'version "(\d+)') {
            if ([int]$Matches[1] -ge 17) { return $c }
            Warn "$c 는 Java $($Matches[1])입니다(17 이상 필요)."
        }
    }
    Fail "Java 17 이상(JDK)이 필요합니다. https://adoptium.net 에서 Temurin JDK를 설치한 뒤 다시 실행하세요."
}

function Find-Adb {
    if ($Adb) {
        if (-not (Test-Path $Adb)) { Fail "adb를 찾을 수 없습니다: $Adb" }
        return $Adb
    }
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cached = Join-Path $Cache "platform-tools\adb.exe"
    if (-not (Test-Path $cached)) {
        Info "adb가 없어 Google platform-tools를 받습니다."
        $zip = Join-Path $Cache "platform-tools.zip"
        Invoke-WebRequest -Uri "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive $zip -DestinationPath $Cache -Force
        Remove-Item $zip -Force
    }
    return $cached
}

# Gadget은 .xz로만 배포된다. Windows엔 xz 해제기가 없어서 Java(xz-java)로 푼다.
function Expand-Xz([string]$java, [string]$xzJar, [string]$from, [string]$to) {
    $src = Join-Path $Cache "Unxz.java"
    $code = @'
import java.io.*;
import org.tukaani.xz.XZInputStream;

public class Unxz {
    public static void main(String[] a) throws Exception {
        try (InputStream in = new XZInputStream(new BufferedInputStream(new FileInputStream(a[0])));
             OutputStream out = new FileOutputStream(a[1])) {
            in.transferTo(out);
        }
    }
}
'@
    [IO.File]::WriteAllText($src, $code)
    Run $java @("-cp", $xzJar, $src, $from, $to)
}

# 원본과 나란히 설치되도록 패키지명과, 기기 전체에서 겹치면 안 되는 이름(provider authority·permission)을 바꾼다.
# 클래스 이름(com.prpr.musedash.wxapi.*)과 인텐트 액션은 그대로 둔다.
function Edit-Manifest([string]$path) {
    $xml = [IO.File]::ReadAllText($path)
    $from = [regex]::Escape($Source)
    $xml = $xml -replace "package=`"$from`"", "package=`"$Package`""
    $xml = [regex]::Replace($xml, "(android:(?:authorities|host|taskAffinity)=`"(?:cct\.)?)$from(?=[.`"])", "`${1}$Package")
    $xml = $xml -replace "android:name=`"$from\.permission\.", "android:name=`"$Package.permission."
    if ($xml -notmatch "package=`"$([regex]::Escape($Package))`"") { Fail "매니페스트에서 package를 바꾸지 못했습니다." }
    [IO.File]::WriteAllText($path, $xml, (New-Object Text.UTF8Encoding $false))
}

# UnityPlayerActivity.onCreate 맨 앞(.locals와 메서드 annotation 뒤)에서 libfrida-gadget.so를 불러온다.
function Edit-Smali([string]$decoded) {
    $file = Get-ChildItem $decoded -Directory -Filter "smali*" |
        ForEach-Object { Join-Path $_.FullName "com\unity3d\player\UnityPlayerActivity.smali" } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $file) { Fail "UnityPlayerActivity.smali를 찾지 못했습니다." }
    $lines = [Collections.Generic.List[string]]([IO.File]::ReadAllLines($file))
    if ($lines -match '"frida-gadget"') { return }
    $start = $lines.FindIndex({ param($l) $l -like ".method protected onCreate(Landroid/os/Bundle;)V*" })
    if ($start -lt 0) { Fail "onCreate를 찾지 못했습니다." }
    $i = $start + 1
    if ($lines[$i].Trim() -notmatch '^\.locals (\d+)$' -or [int]$Matches[1] -lt 1) { Fail "onCreate의 .locals가 예상과 다릅니다: $($lines[$i])" }
    $i++
    # 코드보다 앞에 와야 하는 지시문(annotation 블록, .param)을 건너뛴다.
    while ($i -lt $lines.Count) {
        $t = $lines[$i].Trim()
        if ($t -like ".annotation*") {
            while ($lines[$i].Trim() -ne ".end annotation") { $i++ }
        } elseif (-not ($t -eq "" -or $t -like ".param*" -or $t -eq ".end param")) {
            break
        }
        $i++
    }
    $lines.InsertRange($i, [string[]]@(
        "    const-string v0, `"frida-gadget`"",
        "",
        "    invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V",
        ""))
    [IO.File]::WriteAllLines($file, $lines, (New-Object Text.UTF8Encoding $false))
}

function Resolve-ModJs {
    if ($ModJs) {
        if (-not (Test-Path $ModJs)) { Fail "mod.js를 찾을 수 없습니다: $ModJs" }
        return (Resolve-Path $ModJs).Path
    }
    $local = Join-Path $Root "..\mod\dist\mod.js"
    if (Test-Path $local) { return (Resolve-Path $local).Path }
    $downloaded = Join-Path $Work "mod.js"
    Info "다운로드: $ReleaseModJs"
    try { Invoke-WebRequest -Uri $ReleaseModJs -OutFile $downloaded -UseBasicParsing }
    catch { Fail "mod.js를 받지 못했습니다. mod 폴더에서 'npm install' 후 'npm run build'로 만들거나 -ModJs로 경로를 주세요." }
    return $downloaded
}

try {
    New-Item -ItemType Directory -Force $Cache, $Work | Out-Null

    Step "1/8 PC 도구 확인"
    $java = Find-Java
    Info "Java: $java"
    $script:AdbExe = Find-Adb
    Info "adb: $script:AdbExe"

    Step "2/8 폰 확인"
    $lines = (Capture $script:AdbExe @("devices")).Text -split "`n" | Select-Object -Skip 1 | Where-Object { $_.Trim() }
    $ready = @($lines | Where-Object { $_ -match "`tdevice$" } | ForEach-Object { ($_ -split "`t")[0] })
    if ($lines -match "`tunauthorized") { Warn "폰 화면에 'USB 디버깅 허용' 창이 떠 있으면 [허용]을 누르고 다시 실행하세요." }
    if ($Serial) {
        if ($ready -notcontains $Serial) { Fail "기기 $Serial 이(가) 연결돼 있지 않습니다. 연결된 기기: $($ready -join ', ')" }
    } elseif ($ready.Count -eq 0) {
        Fail "연결된 폰이 없습니다. 개발자 옵션에서 USB 디버깅을 켜고 USB로 연결하세요."
    } elseif ($ready.Count -gt 1) {
        Fail "폰이 여러 대입니다. -Serial 로 하나를 고르세요: $($ready -join ', ')"
    } else {
        $script:Serial = $ready[0]
    }
    Info "기기: $script:Serial ($(AdbText @('shell', 'getprop ro.product.model')))"

    $abi = AdbText @("shell", "getprop ro.product.cpu.abi")
    if ($abi -ne "arm64-v8a") { Fail "arm64-v8a 기기만 지원합니다(이 기기: $abi)." }

    $dump = AdbText @("shell", "dumpsys package $Source")
    if ($dump -notmatch "versionCode=(\d+)") { Fail "폰에 Muse Dash($Source)가 없습니다. Play 스토어에서 설치하고 한 번 실행해 데이터(OBB)까지 받으세요." }
    if ($Matches[1] -ne $VersionCode) { Fail "Muse Dash 버전이 다릅니다(versionCode $($Matches[1])). 이 모드는 6.8.0 (632) 전용입니다." }
    Info "Muse Dash 6.8.0 (632) 확인"

    $obbName = "main.$VersionCode.$Source.obb"
    $obbSrc = "/sdcard/Android/obb/$Source/$obbName"
    $obbDir = "/sdcard/Android/obb/$Package"
    $obbDst = "$obbDir/main.$VersionCode.$Package.obb"
    if (-not $SkipObb) {
        $obbSize = AdbText @("shell", "stat -c %s $obbSrc")
        if ($obbSize -notmatch '^\d+$') { Fail "정품 OBB가 없습니다($obbSrc). 원본 Muse Dash를 한 번 실행해 데이터를 받은 뒤 다시 하세요." }
        Info "OBB: $([math]::Round([double]$obbSize / 1MB)) MB"
    }

    Step "3/8 도구 준비 (처음 한 번만 받음)"
    $apktool = Get-Tool "apktool"
    $signer = Get-Tool "signer"
    $gadgetSo = Join-Path $Cache "libfrida-gadget-17.24.3.so"
    if (-not (Test-Path $gadgetSo)) {
        $xz = Get-Tool "xz"
        $gadgetXz = Get-Tool "gadget"
        Expand-Xz $java $xz $gadgetXz "$gadgetSo.part"
        Move-Item "$gadgetSo.part" $gadgetSo -Force
    }
    $modJsPath = Resolve-ModJs
    Info "mod.js: $modJsPath"

    Step "4/8 폰에서 정품 APK 꺼내기"
    $paths = @((AdbText @("shell", "pm path $Source")) -split "`n" | Where-Object { $_ -like "package:*" } | ForEach-Object { $_.Substring(8).Trim() })
    if ($paths.Count -ne 1) { Fail "APK가 $($paths.Count)개로 나뉘어 설치돼 있습니다(split APK). 지원하지 않는 설치 형태입니다." }
    $baseApk = Join-Path $Work "base.apk"
    AdbRun @("pull", $paths[0], $baseApk)
    if ((Get-FileHash $baseApk -Algorithm SHA256).Hash -ne $KnownApkSha256) {
        Warn "APK 해시가 확인된 Play 6.8.0 빌드와 다릅니다. 같은 632라도 다른 스토어 빌드면 동작하지 않을 수 있습니다."
    }

    Step "5/8 복제본 만들기 ($Package)"
    $decoded = Join-Path $Work "decoded"
    if (Test-Path $decoded) { Remove-Item $decoded -Recurse -Force }
    Run $java @("-jar", $apktool, "d", "-f", "-o", $decoded, $baseApk)
    Edit-Manifest (Join-Path $decoded "AndroidManifest.xml")
    Edit-Smali $decoded
    $libDir = Join-Path $decoded "lib\arm64-v8a"
    if (-not (Test-Path (Join-Path $libDir "libil2cpp.so"))) { Fail "lib\arm64-v8a\libil2cpp.so가 없습니다." }
    Copy-Item $gadgetSo (Join-Path $libDir "libfrida-gadget.so") -Force
    $config = @"
{
  "interaction": {
    "type": "script",
    "path": "/storage/emulated/0/Android/data/$Package/files/mod.js",
    "on_change": "reload"
  }
}
"@
    [IO.File]::WriteAllText((Join-Path $libDir "libfrida-gadget.config.so"), $config, (New-Object Text.UTF8Encoding $false))

    Step "6/8 빌드·서명"
    $unsigned = Join-Path $Work "musedash_mod.apk"
    Run $java @("-jar", $apktool, "b", "-o", $unsigned, $decoded)
    $outDir = Join-Path $Work "out"
    if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
    $signArgs = @("-jar", $signer, "-a", $unsigned, "-o", $outDir)
    if ($Keystore) { $signArgs += @("--ks", $Keystore, "--ksAlias", $KeyAlias, "--ksPass", $KeyPass, "--ksKeyPass", $KeyPass) }
    Run $java $signArgs
    $signed = Get-ChildItem $outDir -Filter "*.apk" | Select-Object -First 1
    if (-not $signed) { Fail "서명된 APK가 만들어지지 않았습니다." }
    Remove-Item $decoded -Recurse -Force
    Remove-Item $baseApk, $unsigned -Force

    Step "7/8 설치"
    $install = Capture $script:AdbExe (AdbArgs @("install", "-r", $signed.FullName))
    Info $install.Text
    if ($install.Text -match "INSTALL_FAILED_UPDATE_INCOMPATIBLE") {
        Fail ("이미 다른 키로 서명된 $Package 가 설치돼 있습니다. 복제본을 지우면 복제본의 세이브·다운로드가 사라집니다. " +
              "지워도 되면 'adb uninstall $Package' 후 다시 실행하고, 아니면 -Keystore로 예전 키를 주세요.")
    }
    if ($install.Text -notmatch "Success") { Fail "설치 실패" }

    if (-not $SkipObb) {
        $have = AdbText @("shell", "stat -c %s $obbDst 2>/dev/null")
        if ($have -eq $obbSize) {
            Info "OBB가 이미 있습니다."
        } else {
            Info "OBB를 폰 안에서 복사합니다(2 GB, 1~3분)."
            $cp = AdbShell "mkdir -p $obbDir && cp $obbSrc $obbDst"
            if ($cp.Code -ne 0) { Fail "OBB 복사 실패: $($cp.Text) (저장 공간이 2.1 GB 이상 남아 있는지 확인하세요)" }
            if ((AdbText @("shell", "stat -c %s $obbDst")) -ne $obbSize) { Fail "OBB 크기가 원본과 다릅니다. 저장 공간을 확인하세요." }
        }
    }

    Step "8/8 모드 넣기"
    $files = "/sdcard/Android/data/$Package/files"
    $mk = AdbShell "mkdir -p $files/hwa"
    if ($mk.Code -ne 0) { Fail "앱 폴더를 만들지 못했습니다: $($mk.Text)" }
    # 앱이 직접 만든 파일은 0600이라 adb로 못 읽는다 → mod.log를 미리 만들어 두고 앱은 거기에 이어 쓰게 한다.
    AdbShell "touch $files/mod.log && chmod 666 $files/mod.log" | Out-Null
    AdbRun @("push", $modJsPath, "$files/mod.js")

    Write-Host ""
    Write-Host "설치 완료." -ForegroundColor Green
    Info "폰 앱 목록에 Muse Dash가 하나 더 생겼습니다(복제본). 원본은 그대로입니다."
    Info "곡 넣기:  adb push <곡 폴더> $files/hwa/<곡 이름>"
    Info "모드 로그: adb shell cat $files/mod.log"
    Info "서명된 APK 사본: $($signed.FullName) (본인 기기용, 남에게 배포하지 마세요)"
    exit 0
}
catch {
    Write-Host ""
    Write-Host "[실패] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
