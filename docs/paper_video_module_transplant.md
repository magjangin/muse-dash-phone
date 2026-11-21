# [기술 논문] 스트리핑된 Unity 비디오 모듈의 안드로이드 이식: 동일 버전 엔진 교체와 C# 래퍼 없는 VideoPlayer 구동

**Transplanting a Stripped Unity Video Module on Android: Same-Version Engine Replacement and Driving VideoPlayer without a Managed Wrapper**

- **저자:** 화평 (화영왕, Muse Dash Archive Project)
- **대상:** *Muse Dash* Android v6.8.0 (versionCode 632), Unity 2019.4.41f1 (changeset fb553f8fdd6c), IL2CPP, arm64-v8a
- **실험 기기:** Galaxy S21 (SM-G991N), Android 15, Mali-G78, OpenGL ES 3.2
- **선행 문서:** [비루팅 환경에서 Unity IL2CPP 모바일 게임 모딩의 패러다임 전환](paper_frida_gadget_android_modding.md) (Frida Gadget 주입 구조)
- **날짜:** 2026년 11월 21일

---

## 요약 (Abstract)

PC판 커스텀 차트 모드는 곡 폴더의 `video.mp4`를 Unity `VideoPlayer`로 배경(BGA)에 깐다. 안드로이드판은 빌드 때 엔진 코드 스트리핑(Strip Engine Code)으로 비디오 모듈이 **C# 쪽(UnityEngine.VideoModule)과 네이티브 엔진 쪽(libunity.so) 모두** 빠져 있어 같은 방법을 쓸 수 없었다. 안드로이드 `MediaPlayer`로 우회한 첫 구현은 실제로는 한 번도 재생된 적이 없었고, 고친 뒤에도 영상이 게임 **위에** 반투명으로 겹쳐 노트를 가렸다.

본 논문은 BCL 이식(오래된 Mono 게임에 다른 게임의 라이브러리를 옮겨 심는 기법)의 발상을 IL2CPP로 옮긴 해법을 보고한다. IL2CPP는 미리 컴파일된 코드라 C# 클래스를 새로 넣을 수 없지만, 엔진 바이너리는 **같은 Unity 버전·같은 빌드의 자르지 않은 공식 런타임**으로 바꿀 수 있다. 바꾼 엔진이 매 프레임 없는 C# 콜백을 불러 죽는 문제는 엔진의 관리 코드 호출 입구에 C로 짠 NULL 가드를 걸어 막았다. 그리고 VideoPlayer C# 클래스 없이, 도너 디버그 심볼로 찾은 엔진 함수로 네이티브 컴포넌트를 만들고 `m_CachedPtr`만 채운 가짜 래퍼로 비디오 내부 함수(icall)를 직접 불렀다. 영상은 RenderTexture를 거쳐 모든 스프라이트 뒤의 캔버스에 그린다.

실기에서 301초 곡 전체를 BGM과 **평균 8~9 ms, 최대 29~41 ms 오차, 시크 0회**로 맞췄고, 게임 스레드 비용은 0.1초마다 최대 0.2~1.1 ms였다(MediaPlayer 방식은 평균 2.6 ms, 최대 20 ms). 피버, 일시정지·재개, 실패, 처음부터, 나가기, 영상 없는 곡, 공식 곡에서 모두 정상 동작하고 크래시가 없었다.

---

## 1. 문제

### 1.1 비디오 모듈이 두 겹으로 잘려 있다

| 확인 항목 | 게임 원래 libunity.so | 같은 버전 공식 런타임 |
| --- | --- | --- |
| 크기 | 17,971,040 B | 23,354,000 B |
| 버전 문자열 | `2019.4.41f1 (fb553f8fdd6c)` | `2019.4.41f1 (fb553f8fdd6c)` |
| 내부 함수(icall) 등록 이름 | 4,733개 | 6,092개 |
| `UnityEngine.Video.VideoPlayer::…` | **0개** | **82개** |

C# 쪽도 `UnityEngine.VideoModule` 어셈블리가 IL2CPP 메타데이터에 없다. 남은 것은 `VideoPlayerProxy` 같은 이름 조각과 디코더 함수(AMediaExtractor) 몇 개뿐이었다.

### 1.2 MediaPlayer 우회의 실패

첫 구현은 안드로이드 `MediaPlayer`를 `TextureView`로 화면에 붙였다. 실측해 보니 다음 이유로 **한 번도 재생되지 않았다**.

1. Unity 창은 하드웨어 가속이 꺼져 있어 `TextureView: A TextureView or a subclass can only be used with hardware acceleration enabled`가 나고 표면이 생기지 않는다.
2. 코드가 Frida 17에서 사라진 전역 `Java`를 썼다(지금은 `frida-java-bridge`를 import해야 한다).

`SurfaceView`로 바꾸자 재생은 됐다. 하지만 두 문제가 남았다.

- **화면 순서**: Unity 화면도 불투명한 SurfaceView라 영상을 그 뒤에 둘 수 없고 위에만 겹칠 수 있다. `View.setAlpha`도 먹지 않아 `SurfaceControl.Transaction.setAlpha`로 레이어 알파를 직접 줘야 했다. 결과적으로 영상이 노트를 반투명하게 덮어 PC(배경 쿼드)와 너무 달랐다.
- **비용**: 영상 위치 확인·속도 변경이 미디어 서버 binder 호출이라, 게임 스레드에서 0.1초마다 평균 2.6 ms, 최대 20 ms가 걸렸다.

### 1.3 Unity 화면을 투명하게 뚫을 수도 없다

진단 모듈(`bgaProbe.ts`)이 렌더 스레드에서 `eglSwapBuffers`를 한 번 엿봐 실제 화면 설정을 읽었다.

| 항목 | 값 |
| --- | --- |
| EGL config | 7: **RGB565, 알파 0비트**, depth 24, stencil 8, MSAA 없음 |
| Unity SurfaceView 형식 | 4 (RGB_565), `IsWindowTranslucent` false |
| 그래픽 | OpenGL ES 3.2, 멀티스레드 렌더링 |
| 카메라 | `Camera_2D`(depth −1, 단색 지우기, 직교), `Camera_3D`(depth 0, 깊이만, 레이어 18) |
| 배경 | `SceneObjectController/scene_XX`, sortingOrder −70~−27 (노트 −15, 보스 −5) |

화면 버퍼에 알파 채널이 없으니 "배경을 지우고 영상을 맨 아래 깐다"는 방법은 쓸 수 없다.

---

## 2. 원리: IL2CPP에서의 "이식"

Mono 게임의 BCL 이식은 런타임이 실행 중에 DLL을 읽어 컴파일하기 때문에 가능하다. IL2CPP는 모든 C# 코드가 `libil2cpp.so` 한 파일에 기계어로 박혀 있어, 새 C# 클래스를 넣을 수 없다. 대신 둘 사이는 이렇게 나뉜다.

- **엔진(libunity.so)**: Unity가 버전마다 미리 빌드해 둔 공용 바이너리다. 스트리핑은 이 파일을 프로젝트마다 다시 링크해 안 쓰는 모듈을 빼는 것이다. 그러니 **같은 버전의 자르지 않은 판**은 게임의 C# 코드와 그대로 맞물린다.
- **C# 쪽(libil2cpp.so)**: 비디오 클래스가 영영 없다. 그래서 C#을 거치지 않고 엔진 함수를 직접 부른다.

### 2.1 도너 확보

Unity 공식 서버의 안드로이드 모듈 설치 파일을 쓴다.

- 주소: `https://download.unity3d.com/download_unity/fb553f8fdd6c/TargetSupportInstaller/UnitySetup-Android-Support-for-Editor-2019.4.41f1.exe`
- 크기·서명: 351,922,256 B, Authenticode 'Unity Technologies SF' 유효
- 추출: 설치하지 않고 Bandizip으로 풀었다.
- 엔진: `Variations/il2cpp/Release/Libs/arm64-v8a/libunity.so`
- 디버그 심볼: `Variations/il2cpp/Release/Symbols/arm64-v8a/libunity.sym.so` (심볼 82,299개)

맞물리는지는 세 가지로 확인했다.

1. 버전 문자열과 changeset이 같다.
2. 함께 들어 있는 `libmain.so`가 게임 것과 바이트 단위로 같다.
3. 디버그 심볼이 있어 엔진 내부 함수를 이름으로 찾을 수 있다.

### 2.2 교체

복제 APK의 `lib/arm64-v8a/libunity.so`만 바꾸고(다른 항목은 압축 방식까지 그대로) 같은 테스트 키로 다시 서명한다. 서명이 같으니 `install -r`로 세이브를 유지한 채 덮어 설치할 수 있다. APK는 100,321,614 B로, 원래보다 약 1.9 MB 커진다.

---

## 3. 부팅: 없는 C# 콜백을 건너뛰는 가드

바꾼 엔진은 시작 직후 UnityMain에서 SIGSEGV(fault addr 0x4a)로 죽었다. 도너 심볼로 스택을 풀면 이렇다.

```
nativeRender → UnityPlayerLoop → PlayerLoop → NavMeshManager::Update
  → ScriptingInvocation::Invoke → scripting_method_invoke → (libil2cpp) NULL+0x4a
```

자르지 않은 엔진은 매 프레임 AI(NavMesh) 모듈의 C# 콜백을 부른다. 그런데 게임에는 그 메서드가 없어 `MethodInfo*`가 NULL이다. 0x4a는 IL2CPP v24 `MethodInfo`의 `parameters_count` 오프셋으로, NULL 메서드를 읽었다는 증거다.

해결은 엔진의 관리 코드 호출 입구 `scripting_method_invoke`(`libunity+0x5dc8c0`)에 가드를 거는 것이다. 메서드가 NULL이면 부르지 않고 NULL을 돌려준다. 이 함수는 매 프레임 여러 번 불리므로 JS 훅이 아니라 **Frida CModule(C) + `Interceptor.replaceFast`**로 건다.

```c
typedef void * (*InvokeFn) (void *, void *, void *, void *, int);
extern void * orig_slot;            /* replaceFast가 돌려준 원본 */
extern int skipped;                 /* 쓰기 가능한 메모리(JS가 할당) */
extern void * last_skipped_caller;

void * guard (void * method, void * obj, void * args, void * exc, int convert)
{
  if (method == 0 || orig_slot == 0) { skipped++; last_skipped_caller = __builtin_return_address (0); return 0; }
  return ((InvokeFn) orig_slot) (method, obj, args, exc, convert);
}
```

- 안전장치: 디스크의 `libunity.so` 크기가 도너와 같고, 대상 주소의 첫 16바이트가 도너 파일과 같을 때만 건다. 원래 엔진에서는 아무것도 하지 않는다.
- 건너뛰는 호출은 초당 약 118번이다. 호출자는 전부 `ScriptingInvocation::Invoke`였다.
- 실패 기록: 카운터를 C 안의 전역 변수(`int skipped = 0;`)로 두자 다시 SIGSEGV가 났다. TinyCC는 전역을 코드와 같은 읽기 전용 페이지에 둔다. 쓰는 값은 JS에서 `Memory.alloc`으로 잡아 `extern`으로 넘겨야 한다.

가드를 건 뒤 부팅 → 타이틀 → 메뉴 → 곡 선택 → 배틀까지 정상이었다. `il2cpp_resolve_icall`로 `UnityEngine.Video.VideoPlayer::Play`(`libunity+0xba460c`) 등 비디오 icall이 실제 주소로 풀렸다.

---

## 4. C# 래퍼 없는 VideoPlayer

### 4.1 네이티브 컴포넌트 만들기

C#의 `AddComponent(Type)`에는 `VideoPlayer`의 `System.Type`이 필요한데, 그런 타입이 없다. 그래서 도너 심볼로 엔진 함수를 직접 찾았다.

| 함수 | 오프셋 | 용도 |
| --- | --- | --- |
| `Unity::Type::FindTypeByName(char const*, CaseSensitivityOptions)` | `0x41a274` | "VideoPlayer" 네이티브 타입 |
| `AddComponentUnchecked(GameObject&, Unity::Type const*, ScriptingClassPtr, core::string*)` | `0x5039ec` | 새 GameObject `hwa_bga`에 붙이기 |

`AddComponentUnchecked`는 스크립팅 클래스와 오류 문자열 인자를 둘 다 먼저 NULL 검사한다(디스어셈블 `cbz x2`, `cbz x20`). 그래서 둘 다 NULL을 넘겨도 된다. GameObject는 C#으로 만들고 `m_CachedPtr`(네이티브 포인터)를 넘긴다. 컴포넌트는 아무도 `GetComponents`로 훑지 않는 새 GameObject에 붙인다. 엔진이 C# 래퍼를 만들려다 실패하는 경로를 피하기 위해서다.

### 4.2 가짜 래퍼로 icall 부르기

IL2CPP의 Unity icall은 `self`(C# 객체)에서 `m_CachedPtr`만 읽어 네이티브 객체를 찾는다. 그래서 `UnityEngine.Behaviour`를 생성자 없이 `alloc()`하고 `m_CachedPtr`에 컴포넌트 포인터를 넣으면 래퍼 역할을 한다. GC가 치우지 않게 GC 핸들로 잡아 두고, 배틀이 끝나면 `m_CachedPtr`를 비우고 핸들을 푼다.

쓴 icall(23개, `il2cpp_resolve_icall`로 주소를 얻어 `NativeFunction`으로 호출):
`set_source`(URL), `set_url`, `set_renderMode`, `set_targetTexture`, `set_aspectRatio`, `set_audioOutputMode`(끔, 소리는 게임 BGM), `set_playOnAwake`, `set_isLooping`, `set_skipOnDrop`, `set_waitForFirstFrame`, `set_playbackSpeed`, `set_time`, `get_time`, `get_length`, `get_frame`, `get_isPrepared`, `get_isPlaying`, `get_width`, `get_height`, `Prepare`, `Play`, `Pause`, `Stop`.

---

## 5. 그리기

| 시도 | 결과 |
| --- | --- |
| `renderMode = CameraFarPlane`, `targetCamera = Camera_2D` | 영상은 나오지만 노트·점수·체력바를 덮음. 스프라이트가 깊이를 쓰지 않아 "먼 평면"이 깊이 테스트를 통과한다. 캐릭터는 `Camera_3D`가 나중에 그려 위에 남음 |
| 영상 전용 카메라(depth −2) + `Camera_2D`는 깊이만 지움, 먼 평면/가까운 평면, cullingMask 0 또는 31번 레이어 | 영상 프레임은 진행하는데(`get_frame` 증가) 화면은 그 카메라의 단색뿐 |
| **`renderMode = RenderTexture` → 전체 화면 RawImage** | **성공** |

최종 구성:

1. `Prepare` 완료(약 1.8~1.9초, 음악 시작 약 4.6초 전)에 영상 크기(1920×1080) RenderTexture를 만들어 `set_targetTexture`로 건다.
2. `Camera_2D`에 Screen Space - Camera 캔버스를 붙인다(`sortingOrder` −100, planeDistance 90). 전체 화면 `RawImage`에 그 텍스처를 띄운다. 20:9 화면에 16:9 영상을 꽉 채우도록 `uvRect`로 위아래를 10%씩 자른다.
3. 같은 때 원래 배경 `scene_XX`의 루트 크기를 0으로 만든다. `SetActive(false)`는 렌더러 332개의 OnDisable이 돌아 614 ms가 걸렸고, 크기 0은 295~568 ms였다. 둘 다 음악 시작 전(레디·고) 한 프레임이다.
4. **피버**: `FeverEffectManager`가 피버 때 자기 배경 `m_Background`(`bg_S`)를 켜 영상을 덮는다. `ActivateFever`·`InvokeNormalFever`·`InvokeBadAppleFever` 뒤에서, 영상이 떠 있을 때만 그것을 끈다. 파티클·문구·색 연출은 그대로다.

화면 버퍼가 RGB565라 영상 색은 16비트로 그려진다.

---

## 6. 싱크

PC 모드(HwaSyncManager)와 같은 규칙이다. 영상이 곡 오디오와 같은 타임라인으로 만들어졌으므로 기준은 게임 시계가 아니라 `bgm.time`이다.

- **시작**: 게임이 음악을 시작하고(`StageBattleComponent.FixedOffset`) BGM이 실제로 돌면 `set_time(bgm.time)` + `Play`.
- **보정**: 0.1초마다 오차를 잰다. 20 ms를 넘으면 오차에 비례해 재생 속도를 최대 ±15% 바꾸고, 0.5초를 넘을 때만 시크한다. 시작·시크 뒤 2초는 쉰다.
- **멈춤**: BGM이 멈추면(일시정지·실패·백그라운드) `Pause`, 다시 돌면 그 위치에서 `Play`.
- **정리**: `End`/`Exit`, 또는 다음 배틀에서 `Stop`하고 래퍼를 비운다. 승리 배너 동안에는 멈추지 않는다.

모든 호출은 네이티브 icall이라 binder 왕복이 없다. 게임 스레드에서 돌려도 0.1초마다 0.2~1.1 ms다.

---

## 7. 실측

il vento d'oro(영상 1920×1080, 60fps, 10.2 Mbps, 301.49초, 곡 301.487초):

| 구간 | 평균 오차 | 최대 오차 | 시크 | 게임 스레드 최대 비용 |
| --- | --- | --- | --- | --- |
| 시작 후 첫 30초 | 13~14 ms | 143~177 ms | 0 | 0.3~0.5 ms |
| 이후 30초 구간들 | 8~9 ms | 29~41 ms | 0 | 0.2~1.1 ms |

| 경우 | 결과 |
| --- | --- |
| 피버 | 피버 배경만 꺼지고 영상 유지 |
| 입력 없이 실패 | BGM 멈춤과 함께 영상 멈춤 |
| 실패 → 처음부터 | 게임 `Exit`로 정리 → 새로 만들어 오차 10 ms로 재시작 |
| 백그라운드 → 일시정지 창 → 재개 | 99.94초에서 멈췄다가 100.06초에서 재개 |
| 일시정지 창 → 나가기 | 정리 후 곡 선택으로 정상 복귀 |
| 영상 없는 커스텀 곡 / 공식 곡 | VideoPlayer를 만들지 않음, 원래 배경 |
| 승리 배너 | 영상이 곡 꼬리까지 이어지다 `End`에서 정리 (이 영상은 295초부터 원래 거의 검정, ffmpeg YAVG 145 → 15) |

모든 경우에 크래시가 없었다.

---

## 8. 한계와 배포

- **엔진 교체가 전제다.** 원래 APK(잘린 엔진)에서는 가드도 VideoPlayer도 꺼진다(`engine-swap full:false`, `vbga-off`). 모드 스크립트(mod.js)만 받는 공개 릴리스로는 BGA가 켜지지 않는다.
- **Unity 런타임 재배포.** 도너는 Unity 공식 런타임 파일이다. 개인 아카이브(PC 인스톨러·XAPK)에는 교체한 APK를 싣지만, 공개 저장소에는 파일을 넣지 않는다. 공개 배포가 필요하면 설치 스크립트가 사용자 PC에서 Unity 서버로부터 직접 받는 방식을 검토해야 한다.
- **주소 고정.** 가드·생성 함수 주소는 이 도너 파일(SHA-256 `50268324…`) 기준이다. 첫 16바이트 대조로 다른 파일이면 꺼지도록 했다.
- **남은 비용.** 배경 끄기 한 프레임(295~568 ms)이 레디·고 중에 남는다.
- **확인 못 한 것.** 화면의 일시정지 버튼은 adb 탭이 먹지 않아 직접 누르지 못했다(같은 BGM 멈춤 경로로 따라감). 이 기기(Mali-G78, Android 15) 외에서는 시험하지 않았다.

---

## 9. 결론

IL2CPP 게임에서 스트리핑된 Unity 모듈은 "없는 기능"이 아니라 **두 층으로 잘린 기능**이다. 엔진 층은 같은 버전의 공식 런타임으로 되살릴 수 있다. C# 층은 없는 채로 두고, 그 대신 엔진이 없는 C# 콜백을 부를 때 건너뛰게 만들고, 엔진 함수와 icall을 직접 부르면 된다. 이 방법으로 Muse Dash Android에서 PC 모드와 같은 배경 BGA를 구현했고, PC 수준의 싱크(평균 8~9 ms)를 MediaPlayer 우회보다 훨씬 적은 비용으로 얻었다.

같은 틀은 비디오 외의 잘린 모듈(예: AI, 물리 확장, 기타 엔진 기능)에도 쓸 수 있다. 필요한 것은 다섯 가지다.

1. 같은 버전 도너 엔진
2. 도너 디버그 심볼
3. NULL 메서드 가드
4. 가짜 래퍼
5. icall 직접 호출

---

## 부록 A. 재현 순서

1. 위 주소에서 안드로이드 모듈 설치 파일을 받아 서명을 확인하고, 설치하지 않고 압축만 푼다.
2. 복제 APK의 `lib/arm64-v8a/libunity.so`를 도너 `Variations/il2cpp/Release/Libs/arm64-v8a/libunity.so`로 바꾸고 같은 키로 다시 서명한다.
3. mod.js에 `engineSwap.ts`(NULL 가드)와 `videoBga.ts`(VideoPlayer)를 넣는다. 가드는 첫 프레임 전(`il2cpp-ready` 직후)에 걸어야 한다.
4. 곡 폴더에 `video.mp4`를 두고, info.txt나 전역 설정에서 시네마를 끄지 않았으면 배틀에서 `vbga-created → vbga-prepared → vbga-display → vbga-started`가 찍힌다.

## 부록 B. 로그 이벤트

| 이벤트 | 뜻 |
| --- | --- |
| `engine-swap {full, size}` | 교체한 엔진인지, 가드를 걸었는지 |
| `engine-swap-skipped {total, since, lastCaller}` | NULL 메서드로 건너뛴 엔진→C# 호출 수(10초마다) |
| `bga-probe-unity / -egl / -android / -scene` | 가능성 진단(그래픽 API, EGL 알파, 창·테마, 카메라·배경) |
| `vbga-created / -prepared / -display / -started` | VideoPlayer 생성 → 준비 → 화면 연결·배경 끄기 → 재생 시작 |
| `vbga-drift {avgMs, maxMs, seeks, costMaxUs}` | 30초마다 오차·비용 |
| `vbga-fever-bg` | 피버 배경 끔 |
| `vbga-paused / -resumed / -stopped {why}` | 일시정지·재개·정리(end/exit/new-battle) |
