# [실전 쿡북] 안드로이드 Unity IL2CPP 모딩 마스터 가이드: 기기 연결부터 PC 모드 이식까지의 전 과정 & 코드 스니펫

**Android Unity IL2CPP Modding Step-by-Step Practical Cookbook: From Device Setup to PC Mod Porting with Concrete Code Snippets**

- **작성자:** 화평 (화영왕)
- **대상 독자:** "안드로이드 모딩을 처음 시도하거나, PC 모드(MelonLoader/BepInEx)를 모바일로 포팅하려는 모더"
- **준비물:** 안드로이드 스마트폰, USB 케이블, PC (Windows/Linux/macOS), Node.js, Java(JDK)

---

## 📌 한눈에 보는 전체 워크플로 (TL;DR)

```
[1단계: 폰 설정] ➔ 개발자 옵션 & USB 디버깅 켜기 (PC와 adb 연결)
       ▼
[2단계: 앱 추출] ➔ adb pull로 폰에서 정품 APK와 OBB를 PC로 복사
       ▼
[3단계: 정적 분석] ➔ Il2CppDumper로 C# 구조(dump.cs/DummyDll) 복원 후 PC 모드와 대조
       ▼
[4단계: 가젯 주입] ➔ UnityPlayerActivity.smali에 1줄 추가 + libfrida-gadget.so 배치 + .mod 복제 패키징
       ▼
[5단계: 모드 이식] ➔ PC의 Harmony(C#) 코드를 frida-il2cpp-bridge(TS) 코드 스니펫으로 1:1 변환
       ▼
[6단계: 핫리로드] ➔ adb push mod.js 단 한 줄로 게임 재실행 없이 0.5초 만에 실시간 반영!
```

---

## STEP 1. 스마트폰 준비 및 USB 디버깅 연결

PC와 스마트폰이 통신할 수 있도록 USB 디버깅을 활성화합니다.

1. **개발자 옵션 활성화**:
   * 스마트폰 `설정` ➔ `휴대전화 정보` ➔ `소프트웨어 정보` ➔ **`빌드 번호`를 7번 연속 터치**.
   * "개발자 모드를 켰습니다" 알림 확인.
2. **USB 디버깅 켜기**:
   * `설정` ➔ `개발자 옵션` ➔ **`USB 디버깅` 켜기(ON)**.
3. **PC와 연결 및 인증**:
   * USB 케이블로 스마트폰을 PC에 연결.
   * 스마트폰 화면에 "USB 디버깅을 허용하시겠습니까?" 팝업이 뜨면 **"이 컴퓨터에서 항상 허용" 체크 후 [허용]**.
4. **연결 확인 (PC 터미널)**:
   ```bash
   adb devices
   ```
   * 출력 예시:
     ```text
     List of devices attached
     R3CN10XXXXX    device
     ```
   * `unauthorized`가 뜨면 폰 화면에서 허용 팝업을 다시 확인하고, `offline`이면 케이블을 재연결합니다.

---

## STEP 2. 기기에서 정품 APK 및 OBB 파일 끌어오기 (Pull)

기기에서 변조할 대상 앱의 APK와 대용량 에셋(OBB)을 PC 작업 디렉터리로 복사합니다.

```bash
# 1. 대상 앱의 패키지명 검색 (예: musedash)
adb shell pm list packages | grep musedash
# 결과: package:com.prpr.musedash

# 2. APK가 설치된 내부 경로 확인
adb shell pm path com.prpr.musedash
# 결과: package:/data/app/~~.../com.prpr.musedash-.../base.apk

# 3. APK를 PC로 다운로드
adb pull /data/app/~~.../com.prpr.musedash-.../base.apk ./com.prpr.musedash_v6.8.0.apk

# 4. OBB 파일이 있는 경우 OBB도 다운로드
adb pull /sdcard/Android/obb/com.prpr.musedash/ ./obb_backup/
```

---

## STEP 3. 정적 분석 및 IL2CPP 심볼 덤프 (C# 구조 복원)

IL2CPP는 C# 코드를 C++ 네이티브 머신코드로 컴파일하므로, 내부 구조를 보려면 메타데이터를 덤프해야 합니다.

### 3.1 APK 압축 해제 및 핵심 파일 추출
```bash
# apktool을 사용하여 APK 디컴파일
apktool d com.prpr.musedash_v6.8.0.apk -o apk_decoded
```
디컴파일된 폴더에서 다음 두 파일을 찾습니다:
1. 네이티브 엔진 바이너리: `apk_decoded/lib/arm64-v8a/libil2cpp.so`
2. 메타데이터 파일: `apk_decoded/assets/bin/Data/Managed/Metadata/global-metadata.dat`

### 3.2 Il2CppDumper 실행
`Il2CppDumper.exe`를 실행하고 위 두 파일의 경로를 입력합니다.
* **생성되는 핵심 결과물**:
  * `dump.cs`: 게임 내 모든 클래스, 구조체, 메서드 시그니처, 필드 오프셋, 메모리 주소(RVA)가 담긴 C# 스켈레톤 파일.
  * `DummyDll/`: ILSpy나 dnSpy로 열어볼 수 있는 가짜 C# DLL 모음 (`Assembly-CSharp.dll` 등).

> **💡 분석 팁:**  
> PC 모드 소스 코드에서 쓰던 클래스명(예: `GameLogic.GameTouchPlay`)과 메서드명(`TouchResult`)을 `dump.cs`에서 검색합니다. 모바일 빌드에서도 클래스와 메서드 구조는 95% 이상 동일합니다!

---

## STEP 4. Frida Gadget 주입 및 Side-by-Side 복제 패키징

이제 앱 스스로 Frida 런타임을 구동하도록 라이브러리를 주입하고, 정품 세이브 데이터를 보존하기 위해 패키지명을 복제합니다.

### 4.1 smali 엔트리포인트에 로더 주입
텍스트 에디터로 `apk_decoded/smali/com/unity3d/player/UnityPlayerActivity.smali`를 엽니다.  
`.method protected onCreate(Landroid/os/Bundle;)V`의 시작 지점(어노테이션 직후)에 아래 **2줄**을 삽입합니다:

```smali
# UnityPlayerActivity.smali -> onCreate 메서드 내부
.method protected onCreate(Landroid/os/Bundle;)V
    .locals 2

    # [주입 코드 시작] Frida Gadget 강제 로드
    const-string v0, "frida-gadget"
    invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V
    # [주입 코드 끝]

    invoke-super {p0, p1}, Landroid/app/Activity;->onCreate(Landroid/os/Bundle;)V
    ...
```

### 4.2 Frida Gadget 바이너리 및 설정 배치
1. [Frida 공식 릴리즈](https://github.com/frida/frida/releases)에서 `frida-gadget-<버전>-android-arm64.so.xz` 다운로드 후 압축 해제.
2. 파일명을 `libfrida-gadget.so`로 변경하여 `apk_decoded/lib/arm64-v8a/`에 복사.
3. 같은 폴더에 `libfrida-gadget.config.so` 파일을 만들고 아래 JSON을 입력:

```json
{
  "interaction": {
    "type": "script",
    "path": "/storage/emulated/0/Android/data/com.prpr.musedash.mod/files/mod.js",
    "on_change": "reload"
  }
}
```
> **⚠️ 주의:** 안드로이드 패키징 시 `.so` 확장자가 아니면 라이브러리 디렉터리에서 누락되므로 반드시 설정 파일명을 `.config.so`로 작성해야 합니다.

### 4.3 Side-by-Side 복제 패키지 설정 (`AndroidManifest.xml`)
정품 앱(`com.prpr.musedash`)과 충돌 없이 동시에 깔릴 수 있도록 수정합니다:
1. `package="com.prpr.musedash"` ➔ `package="com.prpr.musedash.mod"`
2. 모든 `<provider>` 태그 내의 `android:authorities="...특정값..."` 뒤에 `.mod`를 붙임 (중복 방지).
3. 푸시 서비스나 권한 태그 중 패키지명이 명시된 곳을 전부 `.mod`로 변경.

### 4.4 재빌드, 서명 및 기기 설치
```bash
# 1. APK 재빌드
apktool b apk_decoded -o modded_unsigned.apk

# 2. 서명 (uber-apk-signer 또는 apksigner)
uber-apk-signer -a modded_unsigned.apk --allowResign -o ./dist

# 3. 정품 OBB를 복제 패키지 폴더로 복사
adb shell mkdir -p /sdcard/Android/obb/com.prpr.musedash.mod/
adb push ./obb_backup/main.632.com.prpr.musedash.obb /sdcard/Android/obb/com.prpr.musedash.mod/main.632.com.prpr.musedash.mod.obb

# 4. 복제 모드 앱 설치
adb install -r ./dist/modded_unsigned-aligned-debugSigned.apk
```

---

## STEP 5. PC 모드(C#)를 Frida(TS)로 이식하는 핵심 코드 스니펫

PC의 MelonLoader/Harmony 모드 코드를 `frida-il2cpp-bridge` 기반의 TypeScript 코드로 1:1 변환하는 패턴들입니다.

### 프로젝트 초기 설정 (PC 작업 폴더)
```bash
mkdir my-mod && cd my-mod
npm init -y
npm install frida-il2cpp-bridge
npm install --save-dev typescript esbuild
```

---

### [패턴 1] Harmony Postfix (함수 반환값 변조 / 항상 참 반환)
* **상황:** 오토플레이 여부처럼 불리언을 돌려주는 함수를 항상 true로 통과시키고 싶을 때.

**PC C# (Harmony):**
```csharp
[HarmonyPatch(typeof(DBSkill), "get_isAutoPlay")]
public class AutoPlayPatch {
    public static void Postfix(ref bool __result) {
        __result = true; // 항상 오토플레이
    }
}
```

**Android TypeScript (Frida Gadget):**
```typescript
import "frida-il2cpp-bridge";

Il2Cpp.perform(() => {
    const DBSkill = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.Database.DBSkill");
    
    // get_isAutoPlay 메서드 후킹
    DBSkill.method("get_isAutoPlay").implementation = function () {
        // 원본 함수를 부르지 않고 반환값을 항상 true로
        return true;
    };
});
```

---

### [패턴 2] Harmony Prefix (입력 인자 조작 및 판정 강제 승격)
* **상황:** 노트 타격 판정 결과(Miss/Cool/Great)를 Perfect로 실시간 승격시키고 싶을 때.

**PC C# (Harmony):**
```csharp
[HarmonyPatch(typeof(GameTouchPlay), "TouchResult")]
public class PerfectPatch {
    public static void Prefix(ref int idx, ref bool isTouch, ref bool isLongPress) {
        // 인자 변조 또는 사전 처리
    }
    public static void Postfix(ref int __result) {
        __result = 4; // Perfect 판정 강제
    }
}
```

**Android TypeScript (Frida Gadget):**
```typescript
Il2Cpp.perform(() => {
    const GameTouchPlay = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("GameLogic.GameTouchPlay");
    
    GameTouchPlay.method("TouchResult").implementation = function (idx: number, isTouch: boolean, isLongPress: boolean) {
        // 필요 시 원본 실행: const original = this.method("TouchResult").invoke(idx, isTouch, isLongPress);
        
        // 4 = Perfect 판정 반환
        return 4;
    };
});
```

---

### [패턴 3] Struct / Class 내부 필드 읽기 및 수정 (Memory Offset)
* **상황:** 클래스나 구조체 인스턴스의 내부 변수 값을 강제로 덮어써야 할 때.

**PC C# (Direct Access / Reflection):**
```csharp
// MusicInfo 인스턴스의 unlockLevel을 0으로 강제
musicInfo.unlockLevel = 0;
```

**Android TypeScript (Frida Gadget):**
```typescript
Il2Cpp.perform(() => {
    const MusicInfo = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("MusicInfo");
    
    MusicInfo.method("Init").implementation = function (id: number) {
        // 1. 원본 초기화 먼저 실행
        this.method("Init").invoke(id);
        
        // 2. 고수준 필드 접근으로 수정
        this.field("unlockLevel").value = 0;
        
        // 또는 저수준 메모리 오프셋 직접 쓰기 (dump.cs의 오프셋 0xDC 참고)
        // this.handle.add(0xDC).writeS32(0);
    };
});
```

---

### [패턴 4] 에셋 로더 가로채기 및 외부 파일 주입 (Custom Asset/Chart)
* **상황:** 게임이 내장 에셋번들을 로드할 때 가로채서 로컬 BMS나 외부 OGG 음원을 제공할 때.

**Android TypeScript (Frida Gadget):**
```typescript
Il2Cpp.perform(() => {
    const ResourcesManager = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("ResourcesManager");
    
    // generic 메서드 또는 오버로드 메서드 지정
    const loadMethod = ResourcesManager.method("LoadFromName");
    
    loadMethod.implementation = function (assetName: Il2Cpp.String) {
        const name = assetName.content;
        
        // 만약 우리가 정의한 커스텀 곡 에셋 요청이라면?
        if (name && name.startsWith("custom_chart_")) {
            console.log(`[Mod] 커스텀 차트 가로채기: ${name}`);
            // 커스텀 생성한 객체 포인터 반환 또는 메모리 객체 리턴
            return getCustomStageInfo(name);
        }
        
        // 아니면 게임 원본 로더 호출
        return this.method("LoadFromName").invoke(assetName);
    };
});
```

---

### [패턴 5] 안드로이드 네이티브 Java 기능 호출 (UI 토스트 / 하드웨어 비디오)
* **상황:** Unity 엔진에서 제공하지 않는 안드로이드 네이티브 토스트 메시지를 띄우거나 비디오를 재생할 때.

**Android TypeScript (Frida Gadget):**
```typescript
// Java 런타임 진입
Java.perform(() => {
    const Toast = Java.use("android.widget.Toast");
    const ActivityThread = Java.use("android.app.ActivityThread");
    
    const context = ActivityThread.currentApplication().getApplicationContext();
    
    // UI 스레드에서 토스트 메시지 출력
    Java.scheduleOnMainThread(() => {
        Toast.makeText(context, Java.use("java.lang.String").$new("Muse Dash 모드가 정상 로드되었습니다!"), 1).show();
    });
});
```

---

## STEP 6. 초고속 0.5초 핫리로드 개발 루프 (The Holy Grail)

이 아키텍처의 가장 큰 마법은 **"컴파일 - 재설치" 과정이 완전히 사라진다는 것**입니다.

### 1. 스크립트 빌드 및 단말기 전송 스크립트 설정
`package.json`의 scripts에 다음 단축 명령을 등록합니다:

```json
{
  "scripts": {
    "build": "esbuild src/index.ts --bundle --outfile=build/mod.js",
    "push": "npm run build && adb push build/mod.js /sdcard/Android/data/com.prpr.musedash.mod/files/mod.js",
    "watch": "nodemon --watch src -e ts --exec \"npm run push\""
  }
}
```

### 2. 실전 개발 흐름
1. 스마트폰에서 게임 실행 (복제 앱 구동).
2. PC에서 TypeScript 코드를 수정하고 저장.
3. 터미널에서 `npm run push` 실행 (소요 시간: **0.5초**).
4. **결과:** 스마트폰의 Frida Gadget이 파일 변경을 감지하고, **게임이 켜져 있는 상태에서 새 로직이 즉시 적용됨!**

---

## STEP 7. PC 없는 최종 배포용 APK 패키징

개발이 완료되어 다른 사용자들에게 배포할 때는, 사용자가 PC나 `adb`를 쓰지 않아도 되도록 `mod.js`를 APK 내부에 완전히 내장시킵니다.

1. 빌드된 `mod.js`를 `apk_decoded/lib/arm64-v8a/libfrida-gadget.script.so`로 이름을 바꾸어 복사.
2. `libfrida-gadget.config.so`를 상대 경로로 수정:
   ```json
   {
     "interaction": {
       "type": "script",
       "path": "libfrida-gadget.script.so",
       "on_change": "ignore"
     }
   }
   ```
3. `apktool b apk_decoded`로 패키징 후 서명하여 배포 ➔ **설치만 하면 바로 모드가 실행되는 완제품 완성!**

---

## 💡 요약: 모더가 기억해야 할 단 3가지

1. **인앱 진입:** `UnityPlayerActivity.onCreate`에 `System.loadLibrary("frida-gadget")`만 넣으면 비루팅 장벽은 끝난다.
2. **복제 패키지:** 패키지명을 `.mod`로 바꾸어 정품 세이브와 공존시킨다.
3. **핫리로드 개발:** `on_change: reload` 설정으로 `adb push mod.js` 한 줄이면 0.5초 만에 모드가 갱신된다.
