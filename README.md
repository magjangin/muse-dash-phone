# muse-dash-phone 🎵📱

**Muse Dash Android에서 내가 만든 BMS 커스텀 차트를 플레이하는 모드**입니다.
PC 모드 [muse-dash-test](https://github.com/magjangin/muse-dash-test)(MelonLoader)의 커스텀 차트 파이프라인 및 편의 기능을 **루팅 없이** 안드로이드로 옮겼습니다. 방식은 Frida Gadget + TypeScript([frida-il2cpp-bridge](https://github.com/vfsfitvnm/frida-il2cpp-bridge))입니다.

> 이 저장소에는 게임 파일(APK·OBB·`libil2cpp.so`·덤프·디컴파일 코드)이 **하나도 없습니다**. 게임은 본인 기기에 설치된 정품에서 직접 꺼내 쓰세요.

---

## ✨ 지원 기능

실기(Galaxy S21, Android 15)에서 직접 검증 완료되었습니다.

- **"실험 모드" 커스텀 태그** — 곡 선택 화면 태그 목록에 전용 아이콘과 함께 새 태그가 생기고, 그 아래 **"실험 앨범"**으로 커스텀 곡이 나옵니다.
- **가상 곡 `1999-N` 시스템** — 곡 폴더 하나가 곡 하나. 제목·작곡가·레벨 디자이너·난이도·**자켓**·**미리듣기**까지 완벽하게 표시됩니다.
- **BMS → 노트 주입** — PC 모드 BMS 파서·WAV 규칙 완전 호환. 일반 노트, 롱노트(홀드), 샌드백(연타), 동시치기, 고스트, 하트, 음표, dt(선행 표시 시간) 완벽 지원.
- **오토 플레이 (AutoPlay)** — 수면 린 연출과 함께 전 구간 완벽 자동 연주 지원.
- **강제 퍼펙트 & 올퍼펙트 연출 (All-Perfect)** — 모든 타격 판정을 PERFECT로 승격시키며, 클리어 승리 화면에서 "ALL PERFECT !" 황금 배너 연출 제공.
- **BGA 배경 비디오 재생** — Unity 모듈 스트리핑을 우회하는 Android 네이티브 하드웨어 가속 VideoView 오버레이로 곡 폴더 내 `.mp4` 자동 재생.
- **피버 충전 제어 (Fever)** — `피버충전금지` 옵션으로 피버 발동 차단 가능.
- **본곡 BGM & 고정밀 싱크** — 곡 폴더의 `music.ogg` 재생. 실측 음악 − 게임 시계 **+0.008초** 싱크.
- **보스 스왑 & 씬 전환** — BMS 첫 보스 자동 선택 및 중간 보스 스왑(`swap:<보스>:<씬>`), 씬 변경 시 누락되는 **판정 과녁 고리(HitPoints)** 자동 복원.
- **정확도 & 진행바 동기화** — 커스텀 곡 실제 노트 수 기준 정확도 산출, 곡 길이 기준 실시간 진행바 동기화.
- **커스텀 곡 최고 기록** — 곡·난이도별 최고 점수·등급·콤보·정확도·클리어 수를 `files/record/`에 따로 저장해 준비 화면과 승리 화면에 표시합니다(게임 세이브는 건드리지 않음, 자동 연주는 기록하지 않음).
- **전역 설정 시스템 (`save custom key/config.txt`)** — 게임을 끄지 않고도 텍스트 파일 수정으로 오토, 올퍼펙트, 피버 등을 실시간 온/오프 가능 (핫리로드).
- **안전장치** — 점수 업로드 및 클라우드 세이브 요청을 완벽 차단하여 계정 정지 위험을 방지합니다.

---

## ⚙️ 전역 설정 (`save custom key/config.txt`)

PC 모드의 설정 시스템을 안드로이드로 이식했습니다. 게임이 처음 켜질 때 자동으로 설정 파일이 생성되며, **게임을 끄지 않고 파일을 수정해도 1초 안에 실시간으로 반영**됩니다.

### 설정 파일 경로
```text
/sdcard/Android/data/com.prpr.musedash.mod/files/save custom key/config.txt
```

### 설정 항목 및 기본값
```ini
오토플레이 = false
강제퍼펙트 = true
피버충전금지 = false
시네마 = true
고스트노트보이기 = true
```

| 항목 | 기본값 | 설명 |
|---|:---:|---|
| **`오토플레이`** | `false` | `true`로 설정 시 수면 린(zzz 모션)이 등장하며 전 노트 자동 연주 |
| **`강제퍼펙트`** | `true` | 모든 타격(Miss/Cool/Great)을 Perfect로 보정하고 승리 시 ALL PERFECT 황금 배너 연출 |
| **`피버충전금지`** | `false` | `true`로 설정 시 피버 게이지 충전을 차단 (피버 비활성화 모드) |
| **`시네마`** | `true` | 곡 폴더에 `.mp4`가 있을 때 BGA 배경 동영상 재생 활성화 |
| **`고스트노트보이기`** | `true` | 반투명 고스트 노트를 선명하게(불투명도 1.0) 렌더링 |

> **팁:** 개별 곡의 `hwa info.txt`에 적힌 설정과 전역 설정 중 하나라도 켜져 있으면 해당 기능이 활성화됩니다.

---

## ⚠️ 먼저 읽어 주세요

- **게임 버전 6.8.0 (versionCode 632), arm64 전용**입니다. 다른 버전에선 메모리 주소가 달라 동작하지 않습니다. Play 스토어에서 **Muse Dash 자동 업데이트를 반드시 꺼 두세요**.
- 원본 앱은 건드리지 않고, **패키지명을 바꾼 복제본(`com.prpr.musedash.mod`)** 을 별도로 설치합니다.
- 복제본은 서명이 달라 Google Play 로그인 및 클라우드 세이브가 되지 않는 **오프라인 실험용**입니다.
- **커스텀 곡 점수를 공식 랭킹에 올리지 마세요.** 모드가 업로드를 차단하지만 비정상적인 플레이는 계정에 위험할 수 있습니다.
- **유료 콘텐츠(DLC·Muse Plus) 해금 코드는 포함되어 있지 않습니다.** 기본 제공 곡이나 이미 보유한 곡을 숙주로 활용하세요.

---

## 📦 준비물

- **Windows PC**와 USB 케이블 (또는 폰 단독 실행 시 [Termux 환경](docs/termux_install.md))
- **Java 17 이상 (JDK)** — [Eclipse Temurin](https://adoptium.net) 추천
- **Node.js 20 이상** — TypeScript 모드 번들링에 사용
- **Android 기기**: Play 스토어에서 정품 Muse Dash 6.8.0을 받고 2GB 에셋까지 다운로드 완료된 상태
- 기기 설정에서 **USB 디버깅** 활성화

---

## 🚀 설치 방법

### 1. 모드 번들 빌드
```bash
cd mod
npm install
npm run build
```
`mod/dist/mod.js` 파일이 생성됩니다.

### 2. 원클릭 설치 스크립트 실행
기기를 USB로 연결한 상태에서 **`install/install.bat`**을 더블클릭합니다.

스크립트 수행 작업:
1. 기기에서 정품 APK 추출
2. 패키지명을 `com.prpr.musedash.mod`로 패치하고 Frida Gadget을 주입하여 재서명
3. 복제본 APK 및 OBB(2GB) 복사/설치
4. 빌드된 `mod.js`를 기기에 자동 배치

> **📱 PC 없이 폰 단독으로 설치하고 싶다면?**  
> Termux 터미널에서 다음 스크립트를 실행하면 무선 디버깅을 통해 폰 단독으로 추출·패치·설치까지 한 번에 완료됩니다:  
> ```bash
> bash install/install-termux.sh
> ```
> 상세한 작동 원리와 무선 디버깅 설정법은 [Termux 무인 설치 가이드 (docs/termux_install.md)](docs/termux_install.md)를 참고하세요.

### 3. 모드 소스 수정 후 빠른 업데이트
TypeScript 코드를 수정한 뒤에는 APK를 재설치할 필요 없이 `mod.js`만 밀어 넣으면 즉시 갱신됩니다:
```bash
npm run build
adb push dist/mod.js /sdcard/Android/data/com.prpr.musedash.mod/files/mod.js
```

---

## 🎵 커스텀 곡 넣기

```text
/sdcard/Android/data/com.prpr.musedash.mod/files/
├─ mod.js
├─ hwa_tag_icon.png          ← 실험 모드 태그 아이콘 (선택)
├─ save custom key/
│  └─ config.txt             ← 전역 모드 설정 (오토, 올퍼펙, 피버 등)
└─ hwa/
   ├─ babyshark/             ← 곡 폴더 1 (폴더명 영문 권장)
   │  ├─ hwa info.txt        ← 곡 메타데이터
   │  ├─ chart.bms           ← BMS 채보
   │  ├─ music.ogg           ← 배경음악
   │  ├─ cover.png           ← 자켓 이미지
   │  └─ bg.mp4              ← BGA 배경 동영상 (선택)
   └─ neon/                  ← 곡 폴더 2 ...
```

### 뮤즈대시 모드 비서 앱으로 넣기 (Android 11+)

[뮤즈대시 모드 비서](https://github.com/magjangin/muse-dash-app-support-tool) 앱으로 받은 곡은 `/sdcard/MuseDash/hwa/`에 저장됩니다.
Android 11 이상에서는 게임이 이 폴더의 파일을 직접 읽을 수 없어서, **게임이 시작될 때** 모드가 비서 앱에서 곡을 가져와 위 `hwa/` 폴더로 복사합니다 (`src/hwa/assistant.ts`).

- 새 파일이나 크기가 바뀐 파일만 복사합니다. 가져온 곡 폴더에는 `.from_assistant` 표시 파일이 생깁니다.
- 비서 앱에서 지운 곡은 `.from_assistant`가 있는 폴더만 지웁니다. adb로 직접 넣은 곡은 건드리지 않습니다.
- 곡을 받은 뒤에는 게임을 **완전히 껐다 켜야** 반영됩니다.
- 게임을 강제 종료했거나 기기를 재부팅했다면, 비서 앱을 한 번 열거나 비서 앱의 실행 버튼으로 게임을 켜세요. 그래야 곡을 가져올 권한이 다시 생깁니다.
- 결과는 `mod.log`의 `assistant-sync` 줄에 남습니다 (`copied` = 복사한 파일 수, `removed` = 지운 곡 수).

### `hwa info.txt` 주요 키
PC 모드와 100% 동일한 양식을 지원합니다.

| 키 예시 | 설명 |
|---|---|
| `내가 가져올 uid` | 복제할 숙주 곡 UID (예: `0-4`) |
| `커스텀 곡 제목` | 게임 화면에 표시될 곡 이름 (예: `아기상어`, `neon`) |
| `커스텀 아티스트` | 작곡가 이름 |
| `레벨 디자이너` | 채보 제작자 이름 |
| `씬 번호` | 배경 씬 번호 (예: `1` ~ `12`) |
| `난이도 1` ~ `난이도 5` | 각 난이도별 레벨 숫자 (없는 난이도는 `null`) |
| `offset` | 채보 오프셋 (초 단위) |
| `android delay` | Android 환경 전용 음악 지연 보정 (초 단위, 기본 `0`) |
| `오토플레이` | `활성화` 시 해당 곡 단독 오토플레이 |
| `시네마` | `활성화` 시 BGA 배경 동영상 재생 |
| `커스텀 곡 고스트 보이기` | `활성화` 시 고스트 노트 강제 렌더링 |

BMS 채보 작성 및 `#WAV` 네이밍 규칙은 PC 가이드를 참고하세요:  
[CUSTOM_CHART_GUIDE](https://github.com/magjangin/muse-dash-test/blob/main/docs/guides/CUSTOM_CHART_GUIDE.md) · [BMS_PARSING](https://github.com/magjangin/muse-dash-test/blob/main/docs/guides/BMS_PARSING.md)

---

## 🔍 모드 로그 확인

모드 실행 및 판정 상태는 실시간 JSON 로그로 기록됩니다:
```bash
adb shell cat /sdcard/Android/data/com.prpr.musedash.mod/files/mod.log
```

---

## 🗂️ 프로젝트 구조

```text
mod/                 TypeScript 모드 소스 (npm run build → dist/mod.js)
  src/bms/           BMS 파서 및 #WAV 규격 분석
  src/hwa/           곡 폴더 탐색 및 info.txt 파서
  src/chart/         노트 주입 엔진
  src/config.ts      전역 설정 파일(config.txt) 관리 및 핫리로드
  src/autoplay.ts    오토플레이 로직
  src/allPerfect.ts  올퍼펙트 판정 승격 및 황금 배너 연출
  src/bga.ts         네이티브 VideoView 기반 BGA 엔진
  src/fever.ts       피버 충전 제어
  src/battle.ts      보스 스왑, 씬 전환, 판정 및 라이프 엔진
  src/ghost.ts       고스트 노트 알파 보정
  src/hitpoints.ts   판정 과녁 고리 씬 복원기
  src/progress.ts    진행바 동기화
  src/safety.ts      온라인 차단 및 세이브 안전장치
install/             PC용 원클릭 자동 설치 스크립트
gadget/              Frida Gadget 설정 (Script 모드)
docs/                상세 분석 및 문서
  modder_guide_frida_gadget.md  왜 Frida Gadget이 안드로이드 IL2CPP 모딩의 핵심인가? (모더 가이드)
  ARCHITECTURE.md    내부 후킹 RVA 및 메모리 레이아웃
  BUILD_CLONE.md     수동 복제본 빌드 절차
  termux_install.md  Termux를 활용한 폰 단독 무인 설치 분석
```

---

## 🙏 크레딧

- [Frida](https://frida.re/) & Frida Gadget — 동적 바이너리 계측 엔진
- [frida-il2cpp-bridge](https://github.com/vfsfitvnm/frida-il2cpp-bridge) (vfsfitvnm) — Il2Cpp 정밀 바인딩
- [Il2CppDumper](https://github.com/Perfare/Il2CppDumper), [apktool](https://apktool.org/), [uber-apk-signer](https://github.com/patrickfav/uber-apk-signer)
- 원본 PC 모드: [magjangin/muse-dash-test](https://github.com/magjangin/muse-dash-test)
- Muse Dash © PeroPeroGames. 본 프로젝트는 순수 연구 및 오프라인 커스텀 플레이 목적의 비공식 팬 프로젝트입니다.

---

## 📄 라이선스

코드: [MIT](LICENSE). 게임 관련 리소스와 상표권은 원저작권자에게 있습니다.
