# 복제 패키지(com.prpr.musedash.mod) 만들기

원본 게임은 건드리지 않고, **내 기기에 설치된 Muse Dash를 패키지명만 바꿔 따로 하나 더 설치**합니다. 복제본에 Frida Gadget을 넣어 `mod.js`를 실행합니다. 루팅은 필요 없습니다.

> **보통은 [install/install.bat](../install/install.bat)이 아래 과정을 전부 자동으로 합니다.** 이 문서는 스크립트가 하는 일을 손으로 따라 하거나 문제를 찾을 때 보세요.

> 이 저장소에는 게임 APK·OBB·라이브러리가 없습니다. 모두 **본인 기기에서 직접** 꺼내 쓰세요. 만든 복제 APK는 남에게 배포하지 마세요.

## 준비물

| 도구 | 확인한 버전 |
|---|---|
| Muse Dash Android | **6.8.0 (versionCode 632), arm64-v8a** — 다른 버전이면 RVA가 달라 동작하지 않음 |
| Java | 17 이상 |
| [apktool](https://apktool.org/) | 3.0.3 |
| [uber-apk-signer](https://github.com/patrickfav/uber-apk-signer) | 1.3.0 |
| [Frida Gadget](https://github.com/frida/frida/releases) | 17.24.3 (`frida-gadget-17.24.3-android-arm64.so.xz`) |
| adb | Android platform-tools |

## 1. 기기에서 APK·OBB 꺼내기

```bash
adb shell pm path com.prpr.musedash
```

```bash
adb pull /data/app/<위에서 나온 경로>/base.apk musedash.apk
```

OBB(약 2 GB)는 기기 안에서 복사만 하면 됩니다(7단계).

## 2. 디코드

```bash
java -jar apktool_3.0.3.jar d -f -o decoded musedash.apk
```

## 3. 패키지명 바꾸기 (`decoded/AndroidManifest.xml`)

원본과 나란히 설치하려면 아래 값의 `com.prpr.musedash`를 `com.prpr.musedash.mod`로 바꿉니다.

- `<manifest package="...">`
- 모든 `android:authorities="com.prpr.musedash.…"` (provider 충돌 방지)
- `com.prpr.musedash.permission.…` 같은 앱 전용 permission 이름
- `android:taskAffinity`, 딥링크 `android:host` 중 패키지명이 들어간 것

`com.prpr.musedash.wxapi.*` 같은 **클래스 이름**은 바꾸지 않습니다(smali 경로와 맞아야 함).

## 4. Gadget 로드 코드 넣기

`decoded/smali_classes2/com/unity3d/player/UnityPlayerActivity.smali`의 `onCreate` 맨 앞(`.annotation` 블록 바로 뒤)에 추가:

```smali
    const-string v0, "frida-gadget"

    invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V
```

(`onCreate`가 `.locals 2` 이상이라 `v0`를 그냥 써도 됩니다.)

## 5. Gadget 라이브러리·설정 넣기

```
decoded/lib/arm64-v8a/libfrida-gadget.so          ← 압축 푼 frida-gadget-17.24.3-android-arm64.so
decoded/lib/arm64-v8a/libfrida-gadget.config.so   ← 이 저장소의 gadget/libfrida-gadget.config.json
```

설정은 **script 모드**입니다. 앱이 켜질 때 `files/mod.js`를 실행하고, 파일이 바뀌면 다시 불러옵니다(`on_change: reload`). PC에 붙일 필요가 없습니다.

## 6. 빌드·서명·설치

```bash
java -jar apktool_3.0.3.jar b -o musedash_mod_unsigned.apk decoded
```

```bash
keytool -genkeypair -keystore modtest.keystore -alias modtest -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=modtest"
```

```bash
java -jar uber-apk-signer-1.3.0.jar -a musedash_mod_unsigned.apk --ks modtest.keystore --ksAlias modtest -o out
```

```bash
adb install out/musedash_mod_unsigned-aligned-signed.apk
```

## 7. OBB 복사

```bash
adb shell "mkdir -p /sdcard/Android/obb/com.prpr.musedash.mod && cp /sdcard/Android/obb/com.prpr.musedash/main.632.com.prpr.musedash.obb /sdcard/Android/obb/com.prpr.musedash.mod/main.632.com.prpr.musedash.mod.obb"
```

이후 단계(모드 스크립트·곡 넣기)는 [README](../README.md#설치)를 보세요.

## 막혔던 것들

- **adb 두 개를 섞으면 기기가 offline이 됩니다.** 에뮬레이터 프로그램(Nox 등)이 자기 adb를 띄워 두면 platform-tools adb와 서버 버전이 충돌합니다. 하나만 쓰세요.
- **Git Bash에서 `adb shell ls /sdcard/...`** 는 경로가 `C:/Program Files/Git/sdcard`로 바뀝니다. `MSYS_NO_PATHCONV=1`을 붙이세요.
- Gadget을 listen 모드(`on_load: wait`)로 쓰면 PC 세션이 끊길 때 훅도 사라집니다. 상시 모드에는 script 모드가 맞습니다.
- 서명이 원본과 달라서 Google Play 게임 로그인·클라우드 세이브는 복제본에서 기대하지 마세요. 복제본은 오프라인 실험용입니다.
