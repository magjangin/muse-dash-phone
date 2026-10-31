# 모더를 위한 기술 가이드: 왜 Frida Gadget이 핵심인가?
## (Modder's Guide: Why Frida Gadget is the Silver Bullet for Unity Android IL2CPP)

이 문서는 **Muse Dash Android (Unity 2019.4.41f1, IL2CPP, arm64-v8a)** 및 유사한 Unity 모바일 게임을 분석하고 모딩하려는 모더(Modder)와 리버서(Reverser)를 위한 핵심 아키텍처 가이드입니다.

---

## 1. 안드로이드 모딩에서 마주치는 3대 장벽 (The Dead Ends)

PC 환경에서는 MelonLoader, BepInEx, Harmony 등으로 C# DLL을 주입하는 표준화된 워크플로가 확립되어 있습니다. 하지만 **안드로이드 환경**으로 넘어오면 모더들은 곧바로 세 가지 거대한 벽에 부딪힙니다:

1. **모바일 모드 로더(LemonLoader 등)의 한계**:
   - LemonLoader/MelonLoader-Android는 최신 안드로이드 OS(Android 11~15)의 강화된 메모리 보호 정책(W^X, Scoped Storage)과 Unity 2019+ 특정 IL2CPP 빌드에서 심각한 크래시를 유발하거나 실행조차 되지 않는 경우가 많습니다.
2. **비루팅(Non-Root) 환경과 frida-server의 불가성**:
   - 대부분의 실기기는 루팅되지 않은 순정 상태(Verified Boot, Knox 보호 등)입니다. 따라서 전통적인 리버싱 방식인 `frida-server` 데몬을 기기에 띄우는 것이 불가능합니다.
3. **정품 세이브 삭제 및 서명 불일치 리스크**:
   - 정품 구글 플레이 버전(`com.prpr.musedash`)은 `allowBackup=false`로 설정되어 있어, APK를 변조하여 재서명(Re-signing)하면 서명 불일치로 인해 **기존 정품 앱을 삭제하고 설치**해야 하므로 모든 세이브와 구매 데이터가 영구 유실될 위험이 있습니다.

---

## 2. 핵심 돌파구: Frida Gadget (`libfrida-gadget.so`)

이 모든 난관을 극복한 핵심 열쇠가 바로 **Frida Gadget을 통한 인앱 라이브러리 내장(In-App Injection) 기법**입니다.

### 💡 동작 원리
* Frida Gadget은 외부 디버거 프로세스가 아니라, **앱 자체의 네이티브 공유 라이브러리(`.so`)** 형태로 동작합니다.
* 앱이 구동될 때 스스로 Frida 런타임을 메모리에 로드하므로 **루팅 권한이 전혀 필요 없으며**, 안드로이드 보안 샌드박스 내부에서 합법적으로 Unity 및 IL2CPP 엔진 메모리에 직접 접근합니다.

---

## 3. 실전 구축 레시피 (Implementation Blueprint)

### (1) smali 바이트코드 진입점 주입
앱의 최초 진입점인 `UnityPlayerActivity.onCreate()` 상단(어노테이션 직후)에 Frida Gadget 로드 명령 단 한 줄을 주입합니다:

```smali
# com/unity3d/player/UnityPlayerActivity.smali -> onCreate() 내부
const-string v0, "frida-gadget"
invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V
```

### (2) Gadget 바이너리 및 아키텍처 배치
* `lib/arm64-v8a/libfrida-gadget.so` (공식 Frida Release의 `frida-gadget-<version>-android-arm64.so`)
* `lib/arm64-v8a/libfrida-gadget.config.so` (설정 파일, 아래 4절 참고)
  * *팁: 안드로이드 패키징 시 `.config.so` 확장자로 명명해야 `extractNativeLibs` 과정에서 라이브러리로 인식되어 누락 없이 배포됩니다.*

### (3) 정품 보호를 위한 복제 패키징 (Side-by-Side Clone)
정품 앱과 평화롭게 공존하기 위해 `AndroidManifest.xml`의 주요 식별자를 복제본 전용으로 변경합니다:
* 패키지명: `com.prpr.musedash` ➔ `com.prpr.musedash.mod`
* 모든 Provider의 `android:authorities`: 접미사 `.mod` 추가 (설치 시 provider 충돌 방지)
* 푸시/SDK 퍼미션, `taskAffinity`: 충돌 방지 처리
* OBB 경로: `/sdcard/Android/obb/com.prpr.musedash.mod/`로 복사

---

## 4. '신의 한 수': Gadget Script 모드 & 실시간 핫리로드

Frida Gadget의 기본 모드는 PC가 연결되어 디버깅을 시작할 때까지 앱을 멈춰두는 `listen` 모드입니다. 하지만 배포 및 실기 플레이를 위해서는 **`script` 모드**가 절대적입니다.

### `libfrida-gadget.config.so` 설정값:
```json
{
  "interaction": {
    "type": "script",
    "path": "/storage/emulated/0/Android/data/com.prpr.musedash.mod/files/mod.js",
    "on_change": "reload"
  }
}
```

### 이 설정이 가져다주는 혁신적인 이점:
1. **PC / 터미널 의존성 0%**: USB 케이블이나 PC가 없어도 스마트폰 단독으로 게임 실행 시 모드가 즉시 작동합니다.
2. **실시간 핫리로드 (No-Recompile Modding)**:
   - 코드를 수정할 때마다 APK를 재빌드(`apktool b`)하고, 서명하고, 재설치(`adb install`)할 필요가 없습니다.
   - 단지 `mod.js` 파일 하나만 기기 경로에 덮어쓰면, Gadget이 파일 변경(`on_change: "reload"`)을 감지하여 **게임이 켜진 상태에서 스크립트를 즉시 재실행**합니다!
   - 차트 파서, 연출, 판정 수치 조정 등의 피드백 루프를 수 초 단위로 단축시킬 수 있습니다.

---

## 5. C# 모더의 날개: `frida-il2cpp-bridge` 연동

바이너리 바이트코드 훅(Dobby, Substrate 등)을 네이티브 C++로 작성하면 구조체 오프셋이 바뀔 때마다 다시 빌드해야 합니다. 하지만 TypeScript 환경에서 **`frida-il2cpp-bridge`**를 사용하면 마치 PC의 Harmony 패치나 C# Reflection을 사용하는 것처럼 고수준 API로 IL2CPP 코드를 제어할 수 있습니다:

```typescript
// C# 메서드 가로채기 (예: 타격 판정 강제 Perfect 승격)
Il2Cpp.perform(() => {
    const GameTouchPlay = Il2Cpp.domain
        .assembly("Assembly-CSharp")
        .image.class("GameLogic.GameTouchPlay");

    GameTouchPlay.method("TouchResult").implementation = function (idx, isTouch, isLongPress) {
        const ret = this.method("TouchResult").invoke(idx, isTouch, isLongPress);
        // resultCode: Miss(1), Cool(2), Great(3) -> Perfect(4)
        return 4;
    };
});
```

* **RVA 고정 의존 탈피**: Il2Cpp 메타데이터 테이블을 동적으로 조회하므로, 마이너 패치나 오프셋 변동에도 훨씬 유연하게 대응합니다.
* **구조체/값 타입 처리**: ValueType(Color, Vector2 등)은 `alloc().unbox()`를 통해 메모리 상에서 안전하게 생성 및 주입 가능합니다.

---

## 6. 요약 및 결론

> **"안드로이드 IL2CPP 모딩에서 MelonLoader가 막혔다면, 정답은 Frida Gadget 복제 패키지(`com.prpr.musedash.mod`) + `script` 핫리로드 모드입니다."**

이 아키텍처는 비루팅 순정 기기에서:
1. 정품 세이브를 100% 보존하면서,
2. 단독 실행 가능한 커스텀 차트 엔진,
3. 실시간 핫리로드 개발 환경,
4. C# Harmony 수준의 고수준 후킹 파이프라인

을 제공하는 현존 최고의 안드로이드 Unity 모딩 전략입니다. 모딩을 시작하는 모든 개발자분들께 이 문서가 명확한 이정표가 되기를 바랍니다.
