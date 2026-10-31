# muse-dash-phone 🎵📱

**Muse Dash Android에서 내가 만든 BMS 커스텀 차트를 플레이하는 모드**입니다.
PC 모드 [muse-dash-test](https://github.com/magjangin/muse-dash-test)(MelonLoader)의 커스텀 차트 파이프라인을 **루팅 없이** 안드로이드로 옮겼습니다. 방식은 Frida Gadget + TypeScript([frida-il2cpp-bridge](https://github.com/vfsfitvnm/frida-il2cpp-bridge))입니다.

> 이 저장소에는 게임 파일(APK·OBB·`libil2cpp.so`·덤프·디컴파일 코드)이 **하나도 없습니다**. 게임은 본인 기기에 설치된 정품에서 직접 꺼내 쓰세요.

---

## ✨ 되는 것

실기(Galaxy S21, Android 15)에서 직접 플레이해 확인했습니다.

- **"실험 모드" 커스텀 태그** — 곡 선택 화면 태그 목록에 아이콘과 함께 새 태그가 생기고, 그 아래 **"실험 앨범"** 으로 내 곡이 나옵니다.
- **가상 곡 `1999-N`** — 곡 폴더 하나가 곡 하나. 제목·작곡가·레벨 디자이너·난이도·**자켓**·**미리듣기**까지 내 파일로 표시됩니다.
- **BMS → 노트 주입** — PC 모드 BMS 파서·WAV 이름 규칙 그대로. 홀드·연타(샌드백)·동시치기·고스트·하트·음표·dt(선행 표시 시간) 지원.
- **본곡 BGM 교체** — 곡 폴더의 `music.ogg`로 재생.
- **보스** — BMS 첫 등장 보스로 시작, `swap:<보스>:<씬>`로 곡 중간 보스 교체.
- **씬 변경** — info.txt 씬 번호로. 씬을 바꾸면 빠지는 **판정 과녁 고리(HitPoints)** 도 다시 붙입니다.
- **정확도 / 진행바** — 커스텀 곡 노트 수 기준 정확도, 곡 길이 기준 진행바.
- **BGM 싱크** — 실측 음악 − 게임 시계 **+0.008초**.
- **오토 플레이 & 올퍼펙트 연출** — `info.txt`의 `오토플레이` 지원 및 클리어 시 "ALL PERFECT !" 황금 배너 연출.
- **BGA 배경 비디오** — 곡 폴더 내 `.mp4` 파일 감지 시 Android 네이티브 하드웨어 가속 배경 재생.
- **피버 제어** — `피버충전금지` 설정 시 피버 게이지 충전 차단.
- **안전장치** — 점수 업로드·클라우드 세이브 요청을 막고, 가상 곡이 세이브에 섞이지 않는지 매번 점검합니다.

## ⚠️ 먼저 읽어 주세요

- **게임 버전 6.8.0 (versionCode 632), arm64 전용**입니다. 다른 버전에선 주소가 달라 동작하지 않습니다. 쓰는 동안 Play 스토어에서 **자동 업데이트를 꺼 두세요**.
- 원본 앱은 건드리지 않습니다. **패키지명을 바꾼 복제본(`com.prpr.musedash.mod`)** 을 따로 설치해서 씁니다. 복제본은 서명이 달라 Google 로그인·클라우드 세이브가 안 된다고 보세요. 오프라인 실험용입니다.
- **커스텀 곡 점수를 공식 랭킹에 올리지 마세요.** 모드가 업로드를 막지만, 서버측 치트 판정(랭킹·구매 제한)은 실계정에 걸립니다.
- **유료 콘텐츠(DLC·Muse Plus) 해금 기능은 들어 있지 않습니다.** 숙주 곡은 무료 곡이나 이미 가진 곡을 쓰세요.
- 만든 복제 APK나 게임 파일을 남에게 배포하지 마세요.

## 📦 준비물

- **Windows PC**와 USB 케이블
- **Java 17 이상(JDK)** — 없으면 [Temurin](https://adoptium.net)을 설치하세요.
- **Node.js 20 이상** — `mod.js`를 빌드할 때 씁니다(아직 미리 빌드한 릴리스가 없습니다).
- **폰**: Play 스토어에서 받은 Muse Dash **6.8.0 (632)**. 한 번 실행해서 데이터(약 2 GB)까지 받아 두세요. 저장 공간이 2.5 GB 이상 남아 있어야 합니다.
- 폰의 **USB 디버깅** 켜기: 설정 → 휴대전화 정보 → 소프트웨어 정보 → 빌드번호 7번 탭 → 개발자 옵션 → USB 디버깅.

adb, apktool, uber-apk-signer, Frida Gadget은 설치 스크립트가 처음 실행될 때 받습니다(버전·해시 고정).

## 🚀 설치

### 1. mod.js 빌드 (처음 한 번)

```bash
cd mod
```

```bash
npm install
```

```bash
npm run build
```

`mod/dist/mod.js` 하나가 나옵니다. 설치 스크립트가 이 파일을 폰에 넣습니다.

### 2. 설치 스크립트 실행

폰을 USB로 연결하고 **`install/install.bat`을 더블클릭**하세요. 폰에 'USB 디버깅 허용' 창이 뜨면 [허용]을 누릅니다.

스크립트가 하는 일:

1. 폰에 설치된 정품 APK를 꺼냅니다(게임 파일은 이 저장소에 없습니다).
2. 패키지명을 `com.prpr.musedash.mod`로 바꾸고 Frida Gadget을 넣어 다시 서명합니다.
3. 복제본을 설치하고, OBB(2 GB)를 폰 안에서 복사합니다.
4. `mod.js`를 복제본 폴더에 넣습니다.

원본 앱과 세이브는 건드리지 않습니다. 앱 목록에 Muse Dash가 하나 더 생기면 그게 복제본입니다. 수동으로 하고 싶으면 [docs/BUILD_CLONE.md](docs/BUILD_CLONE.md)를 보세요.

옵션(PowerShell에서 `install\install.ps1 -옵션`):

| 옵션 | 뜻 |
|---|---|
| `-Serial <기기>` | 폰이 여러 대 연결됐을 때 고르기 |
| `-Adb <경로>` | 특정 adb 쓰기. Nox 같은 에뮬레이터 프로그램이 켜져 있으면 **그 프로그램의 adb**를 주세요(두 adb가 섞이면 기기가 offline이 됩니다) |
| `-ModJs <경로>` | 다른 위치의 mod.js 넣기 (기본은 `mod/dist/mod.js`) |
| `-Package <이름>` | 다른 패키지명으로 하나 더 설치 |
| `-SkipObb` | OBB 복사 건너뛰기 |

### 3. 모드를 고친 뒤

`mod/src`를 고쳤으면 `npm run build`로 다시 빌드한 뒤, 스크립트를 다시 돌릴 필요 없이 mod.js만 push하면 됩니다.

```bash
adb push mod/dist/mod.js /sdcard/Android/data/com.prpr.musedash.mod/files/mod.js
```

Gadget이 앱 시작 때 이 파일을 실행합니다. 실행 중에 새로 push하면 자동으로 다시 불러오지만, 태그·곡 등록은 시작할 때 하므로 **앱을 다시 켜는 게 확실합니다.**

### 4. 곡 넣기

```
/sdcard/Android/data/com.prpr.musedash.mod/files/
├─ mod.js
├─ hwa_tag_icon.png          ← 태그 아이콘 (선택)
└─ hwa/
   └─ my-song/               ← 폴더 하나 = 곡 하나 (이름순으로 1999-1, 1999-2 …)
      ├─ hwa info.txt        ← 곡 정보 (.txt 아무 이름, info.txt가 우선)
      ├─ chart.bms           ← 채보 (chart/main/test.bms 우선, 없으면 첫 .bms)
      ├─ music.ogg           ← 본곡 = 미리듣기 (ogg/wav/mp3)
      └─ cover.png           ← 자켓 (png/jpg)
```

예시 info.txt: [examples/hwa/my-song/hwa info.txt](examples/hwa/my-song/hwa%20info.txt). 이 폴더에 내 BMS·OGG·자켓을 같이 넣고 통째로 올리세요.

```bash
adb push examples/hwa/my-song /sdcard/Android/data/com.prpr.musedash.mod/files/hwa/my-song
```

## 📝 info.txt 키

PC 모드와 같은 파일을 그대로 쓸 수 있습니다. 키는 공백·기호를 무시하고 단어가 **포함**되면 인식합니다.

| 키 (예) | 뜻 |
|---|---|
| `내가 가져올 uid` | 숙주 곡 uid (예 `0-4`). 이 곡을 복제해 가상 곡을 만듭니다 |
| `커스텀 곡 제목` / `커스텀 아티스트` / `레벨 디자이너` | 화면에 보일 정보 |
| `씬 번호` | 배경 씬 (1~) |
| `난이도 1` ~ `난이도 5` | 숫자 또는 `null` |
| `offset` | 노트 판정 오프셋(초), PC와 같음 |
| `android delay` | **Android 전용** 음악 지연(초). 기본 0. 음수일수록 음악이 늦게 나옵니다 |
| `delay` | PC 전용 값. **Android에선 읽기만 하고 쓰지 않습니다** (PC 재생 경로 보정값이라 그대로 쓰면 0.57초 늦음) |
| `커스텀 곡 고스트 보이기` | `활성화`/`비활성화` |
| `dt를 권장 표로 고치기` | `활성화`면 dt를 권장 표로 덮어씀 |

**채보(BMS) 쓰는 법**, #WAV 파일명 규칙(`zzxxyy` uid, `_dt1.48`, 보스 표식)은 PC 모드 문서와 같습니다:
[CUSTOM_CHART_GUIDE](https://github.com/magjangin/muse-dash-test/blob/main/docs/guides/CUSTOM_CHART_GUIDE.md) · [BMS_PARSING](https://github.com/magjangin/muse-dash-test/blob/main/docs/guides/BMS_PARSING.md) · [DT_RECOMMENDED_TABLE](https://github.com/magjangin/muse-dash-test/blob/main/docs/guides/DT_RECOMMENDED_TABLE.md)

## 🔧 문제 해결

- 로그: `/sdcard/Android/data/com.prpr.musedash.mod/files/mod.log` (JSON 한 줄씩)
  - 앱이 직접 만든 파일은 권한이 `0600`이라 adb로 읽을 수 없습니다. 설치 스크립트가 `mod.log`를 미리 만들어 두므로 보통은 읽힙니다. `Permission denied`가 나오면 앱을 끄고 `adb shell rm` 후 `touch`·`chmod 666`으로 다시 만드세요.
  - 곡 폴더는 PC에서 `adb push`로 넣으세요. 폰 안에서 `cp -r`로 복사한 폴더는 모드가 파일을 못 읽었습니다(`hwa-skip`).

```bash
adb shell cat /sdcard/Android/data/com.prpr.musedash.mod/files/mod.log
```

| 로그 | 뜻 |
|---|---|
| `mod-loaded`만 있고 `il2cpp-ready`가 없음 | 화면이 꺼진 채로 켜졌을 수 있음. 화면을 켜고 앱을 다시 실행 |
| `hwa-skip` | 곡 폴더에 .txt나 .bms가 없음 |
| `hwa-song` … `unknownKeys` | info.txt에서 못 알아본 키 |
| `chart-injected` | 차트 주입 성공 (노트 수) |
| `sync-sample` `audioMinusGame` | 음악 − 게임 시계(초). 0에서 멀면 `android delay`로 보정 |
| `error` / `frame-error` | 그 기능만 꺼지고 나머지는 계속 동작 |

- 미리듣기를 처음 틀 때 OGG를 디코드하느라 **약 5초 멈춥니다**(이후 캐시). 그 사이 누른 "시작!"은 씹힐 수 있습니다.

## 🚧 아직 안 되는 것

- 커스텀 곡 **최고 기록 저장** (PC의 CustomRecordStore) — 판이 끝나도 기록이 남지 않습니다.
- 실기 테스트는 곡 하나(neon)로만 했습니다. 다른 곡·보스 조합에서 문제가 있으면 `mod.log`와 함께 이슈로 알려 주세요.
- PC 모드의 입력 오버레이·판정바·스킨·디스코드 등 부가 기능은 옮기지 않았습니다.

## 🗂️ 구성

```
mod/                 TypeScript 모드 (npm run build → dist/mod.js)
  src/bms/           BMS 파서, #WAV 이름 규칙
  src/hwa/           곡 폴더·info.txt
  src/chart/         노트 스펙·MusicData 주입
  src/*.ts           태그·배틀·고스트·HitPoints·진행바·안전장치
install/             원클릭 설치 스크립트 (install.bat → install.ps1)
gadget/              Frida Gadget 설정 (script 모드)
examples/hwa/        곡 폴더 예시
docs/BUILD_CLONE.md  복제 APK 만들기
docs/ARCHITECTURE.md 훅 목록·데이터 레이아웃·싱크·실패 기록
```

## 🙏 크레딧

- [Frida](https://frida.re/) / Frida Gadget — 런타임 계측
- [frida-il2cpp-bridge](https://github.com/vfsfitvnm/frida-il2cpp-bridge) (vfsfitvnm) — IL2CPP 이름 기반 접근
- [Il2CppDumper](https://github.com/Perfare/Il2CppDumper), [apktool](https://apktool.org/), [uber-apk-signer](https://github.com/patrickfav/uber-apk-signer)
- 원본 PC 모드: [magjangin/muse-dash-test](https://github.com/magjangin/muse-dash-test)
- Muse Dash © PeroPeroGames. 이 프로젝트는 비공식 팬 모드이며 PeroPeroGames와 관계가 없습니다.

**AI 사용 고지:** 안드로이드 이식(분석·TypeScript 코드·문서)은 Anthropic의 **Claude Code (Claude Opus 5.5)** 가 작성했고, 기획·테스트 곡·실기 검증 판단은 magjangin이 했습니다.

## 📄 라이선스

코드: [MIT](LICENSE). 게임 에셋·상표는 각 권리자에게 있습니다.
