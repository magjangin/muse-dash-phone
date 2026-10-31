# Termux 환경 단독 설치 스크립트 구현 가능성 및 아키텍처 분석

> **목표**: PC(Windows) 연결 없이, 안드로이드 기기 단독 환경(Termux)에서 정품 Muse Dash APK를 추출하여 Frida Gadget 복제 모드 패키지(`com.prpr.musedash.mod`)를 빌드하고 설치·구성하는 스크립트 가능성 검토.

---

## 1. 결론 요약: 가능 여부 및 권장 방식

**결론: 100% 구현 가능 (비루팅 기기 포함)**
Termux는 안드로이드 aarch64(ARM64) 네이티브 리눅스 환경과 Java 런타임(OpenJDK), 패키지 도구(`android-tools`)를 완벽히 지원하므로, 현재 PC용 PowerShell 원클릭 설치 스크립트(`install/install.ps1`)의 모든 단계를 Bash 스크립트(`install_termux.sh`)로 1:1 대체할 수 있습니다.

---

## 2. 필수 도구 체인 및 Termux 패키지 매핑

| 기능 단계 | PC (PowerShell) 환경 | Termux (Android Bash) 환경 | 설치 / 확보 방법 |
| :--- | :--- | :--- | :--- |
| **Java 런타임** | 시스템 JDK (`java.exe`) | OpenJDK 17 / 21 | `pkg install openjdk-17` |
| **디컴파일/리빌드** | `apktool.jar` | `apktool.jar` (aarch64 내장) | Github Releases curl 다운로드 + `java -jar` |
| **정렬 & 서명** | `uber-apk-signer.jar` / `zipalign` | `uber-apk-signer.jar` 또는 `apksigner` | `pkg install android-tools` (zipalign/apksigner) |
| **압축 해제 (xz)** | Java 소스(`Unxz.java`) 컴파일 실행 | `unxz` (네이티브) | `pkg install xz-utils` (단 한 줄로 `.xz` 해제) |
| **Gadget 다운로드**| GitHub Releases curl | `curl -L` | `pkg install curl` |
| **정품 APK 추출** | `adb shell pm path` + `adb pull` | `pm path` + `cp` (또는 local adb) | Termux 로컬 쉘에서 직접 복사 |
| **APK 설치** | `adb install -r` | `termux-open` (인스톨러) 또는 로컬 adb | 시스템 패키지 인스톨러 호출 또는 무선 디버깅 |

---

## 3. 핵심 기술 과제 및 해결책 (Gotchas & Solutions)

### ① 정품 APK (`base.apk`) 읽기 권한
- **현황**: 비루팅 환경이라도 `pm path com.prpr.musedash` 명령으로 정품 APK의 위치(예: `/data/app/~~.../base.apk`)를 조회할 수 있으며, 이 경로는 모든 일반 앱/쉘에 대해 `world-readable`(0644) 권한입니다.
- **해결**: Termux 터미널에서 `cp $(pm path com.prpr.musedash | cut -d: -f2) ./base.apk`로 즉시 작업 디렉터리에 복사 가능.

### ② Scoped Storage 제약 (`/sdcard/Android/obb/` 쓰기)
- **문제**: Android 11+에서는 일반 앱(Termux 포함)이 `/sdcard/Android/obb/` 또는 `/sdcard/Android/data/`에 직접 파일을 생성하거나 복사하는 것이 시스템 레벨에서 차단됩니다.
- **해결 방안 (택 1)**:
  1. **무선 디버깅 (Wireless Debugging - 무루팅 권장)**:
     - Android 개발자 옵션의 "무선 디버깅"을 켜고 Termux에서 `pkg install android-tools` 후 `adb pair`, `adb connect localhost:<port>`로 셀프 ADB 루프백 연결.
     - PC 연결과 100% 동일한 권한(`shell` UID)을 획득하므로, OBB 복사 및 무인 백그라운드 `adb install -r`이 즉시 가능해집니다.
  2. **Shizuku API 연동**:
     - Shizuku가 활성화된 기기라면 `rish` 명령어로 시스템 권한을 위임받아 OBB 복사 수행.
  3. **사용자 수동 이동 안내**:
     - OBB 복제본(`main.632.com.prpr.musedash.mod.obb`)을 `/sdcard/Download/`에 생성해 두고, '파일' 앱(또는 ZArchiver 등)을 통해 OBB 폴더로 이동하도록 안내.

### ③ Gadget 압축 해제 간소화
- PC 환경에서는 Windows 기본 `tar`가 `.xz` 포맷을 처리하지 못해 Java 스크래치 코드로 풀었으나, Termux에서는 리눅스 표준 `xz-utils`가 지원되므로:
  ```bash
  curl -L -o libfrida-gadget.so.xz https://github.com/frida/frida/releases/download/17.24.3/frida-gadget-17.24.3-android-arm64.so.xz
  unxz libfrida-gadget.so.xz
  ```
  단 두 줄로 완벽히 해결됩니다.

---

## 4. 제안하는 `install_termux.sh` 워크플로 구조

```bash
#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "[1/6] 필수 패키지 점검 및 설치..."
pkg update -y
pkg install -y openjdk-17 android-tools xz-utils curl jq

echo "[2/6] 정품 APK 추출..."
BASE_PATH=$(pm path com.prpr.musedash | head -n 1 | cut -d: -f2)
cp "$BASE_PATH" ./base.apk

echo "[3/6] Frida Gadget 및 빌드 도구 준비..."
mkdir -p .cache
# apktool, uber-apk-signer, libfrida-gadget 다운로드 및 캐싱

echo "[4/6] APK 디컴파일 및 복제본 패치..."
# - Manifest 패키지명 변경: com.prpr.musedash.mod
# - UnityPlayerActivity.onCreate smali에 System.loadLibrary("frida-gadget") 주입
# - Gadget 설정 파일(mod.js script 경로) 동봉

echo "[5/6] APK 리빌드 및 서명..."
java -jar .cache/apktool.jar b decoded -o unsigned.apk
java -jar .cache/uber-apk-signer.jar -a unsigned.apk -o out --allowResign

echo "[6/6] 설치 진행..."
# adb(무선디버깅) 또는 termux-open으로 설치
```

---

## 5. 결론 및 로드맵
- **실현 가능성**: **매우 높음 (A급)**.
- **적용 추천**: 무선 디버깅(Wireless Debugging)과 조합할 경우 사용자가 폰 하나만 들고 외부에서도 버튼 한 번으로 모드 앱 생성/업데이트가 가능합니다.
- 본 문서를 기반으로 필요 시 `install/install_termux.sh`를 추가 작성하여 저장소에 제공할 수 있습니다.
