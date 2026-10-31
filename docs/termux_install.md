# Termux 환경 단독 설치 스크립트 가이드 및 아키텍처

> **목표**: PC(Windows) 연결 없이, 안드로이드 기기 단독 환경(Termux)에서 정품 Muse Dash APK를 추출하여 Frida Gadget 복제 모드 패키지(`com.prpr.musedash.mod`)를 빌드하고 설치·구성하는 스크립트 안내.

---

## 1. 개요

Termux는 안드로이드 aarch64(ARM64) 네이티브 리눅스 환경과 Java 런타임(OpenJDK), 패키지 도구(`android-tools`)를 완벽히 지원하므로, PC용 PowerShell 원클릭 설치 스크립트(`install/install.ps1`)와 동일한 전 과정을 Bash 스크립트(`install/install-termux.sh`)로 폰 단독 실행할 수 있습니다.

---

## 2. 필수 도구 체인 및 Termux 패키지 매핑

| 기능 단계 | PC (PowerShell) 환경 | Termux (Android Bash) 환경 | 설치 / 확보 방법 |
| :--- | :--- | :--- | :--- |
| **Java 런타임** | 시스템 JDK (`java.exe`) | OpenJDK 17 / 21 | `pkg install openjdk-17` |
| **디컴파일/리빌드** | `apktool.jar` | `apktool.jar` (aarch64 내장) | Github Releases curl 다운로드 + `java -jar` |
| **정렬 & 서명** | `uber-apk-signer.jar` / `zipalign` | `uber-apk-signer.jar` | GitHub Releases curl 다운로드 + `java -jar` |
| **압축 해제 (xz)** | Java 소스(`Unxz.java`) 컴파일 실행 | `unxz` (네이티브) | `pkg install xz-utils` (단 한 줄로 `.xz` 해제) |
| **Gadget 다운로드**| GitHub Releases curl | `curl -L` | `pkg install curl` |
| **정품 APK 추출** | `adb shell pm path` + `adb pull` | `adb pull` | 무선 디버깅 ADB로 추출 |
| **APK 설치** | `adb install -r` | `adb install -r` | 무선 디버깅 ADB로 설치 |

---

## 3. 핵심 기술 과제 및 해결책 (Gotchas & Solutions)

### ① Scoped Storage 제약 (`/sdcard/Android/obb/` 쓰기)
- **문제**: Android 11+에서는 일반 앱(Termux 포함)이 `/sdcard/Android/obb/` 또는 `/sdcard/Android/data/`에 직접 파일을 생성하거나 복사하는 것이 시스템 레벨에서 차단됩니다.
- **해결**: **무선 디버깅 (Wireless Debugging - 무루팅 권장)**
  - Android 개발자 옵션의 "무선 디버깅"을 켜고 Termux에서 `adb pair`, `adb connect localhost:<port>`로 셀프 ADB 루프백 연결.
  - PC 연결과 100% 동일한 권한(`shell` UID)을 획득하므로, OBB 복사 및 백그라운드 무인 `adb install -r`이 즉시 가능합니다.

### ② Gadget 압축 해제 간소화
- Termux에서는 리눅스 표준 `xz-utils`가 지원되므로:
  ```bash
  curl -L -o libfrida-gadget.so.xz https://github.com/frida/frida/releases/download/17.24.3/frida-gadget-17.24.3-android-arm64.so.xz
  unxz libfrida-gadget.so.xz
  ```
  단 두 줄로 완벽히 해결됩니다.

---

## 4. 원클릭 실행 방법

Termux 터미널에서 아래 명령을 실행합니다:

```bash
# 1. 저장소 클론 (또는 스크립트 다운로드)
git clone https://github.com/magjangin/muse-dash-phone.git
cd muse-dash-phone

# 2. 실행 권한 부여 및 스크립트 실행
chmod +x install/install-termux.sh
bash install/install-termux.sh
```

스크립트가 진행되며:
1. 필수 패키지(`openjdk-17`, `android-tools`, `xz-utils`, `curl`) 자동 설치
2. 무선 디버깅 페어링 및 연결 대화형 안내
3. 정품 APK 추출, Apktool 디컴파일, Frida Gadget 주입, uber-apk-signer 서명
4. 복제본 패키지(`com.prpr.musedash.mod`) 설치 및 2GB OBB 폰 내 복사
5. `files/mod.js`, `save custom key/config.txt` 초기 구성 완료

전 과정이 PC 없이 폰 단독으로 완료됩니다!
