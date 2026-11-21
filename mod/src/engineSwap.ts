// 엔진 교체 실험 지원 (2026-11-21, BGA용 VideoPlayer 이식).
// 복제 APK의 libunity.so를 같은 Unity 버전(2019.4.41f1, fb553f8fdd6c)의 "자르지 않은" 공식 런타임으로 바꾸면
// (tools/swap_libunity_apk.py) 엔진에는 모든 모듈이 들어 있지만 게임의 IL2CPP 쪽(C#)에는 잘린 모듈의 클래스가 없다.
// 첫 실측: 매 프레임 NavMeshManager::Update가 AI 모듈의 C# 콜백을 부르는데 그 메서드가 없어(MethodInfo* = NULL)
// scripting_method_invoke → libil2cpp에서 NULL+0x4a(parameters_count) 읽기로 SIGSEGV(UnityMain, 시작 직후).
// → scripting_method_invoke 입구에서 method가 NULL이면 호출하지 않고 NULL을 돌려준다.
//    매 프레임 여러 번 불리는 함수라 JS 훅이 아니라 CModule(C) + Interceptor.replaceFast로 건다.
//
// 원래(잘린) libunity면 아무것도 하지 않는다: 디스크의 libunity.so 크기가 도너와 같고, 주소의 첫 16바이트가
// 도너 파일과 같을 때만 건다. 주소는 도너 디버그 심볼(Symbols/arm64-v8a/libunity.sym.so)에서 얻었다.
import { log } from "./log.js";
import { regularFileSize } from "./native.js";
import { onFrame } from "./frame.js";

const DONOR_SIZE = 23354000;                       // Release/Libs/arm64-v8a/libunity.so, SHA-256 50268324…
const SCRIPTING_METHOD_INVOKE = 0x5dc8c0;          // scripting_method_invoke(ScriptingMethodPtr, ScriptingObjectPtr, ScriptingArguments&, ScriptingExceptionPtr*, bool)
const PROLOGUE = "ff4301d1f80b00f9f75b02a9f55303a9";

let cm: CModule | null = null;
let swapped = false;

/** 지금 프로세스가 교체한(자르지 않은) 엔진으로 돌고 있는지. */
export function isFullEngine(): boolean { return swapped; }

function hex(p: NativePointer, n: number): string {
    const b = new Uint8Array(p.readByteArray(n)!);
    return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

export function installEngineSwap(): void {
    const unity = Process.findModuleByName("libunity.so");
    if (!unity) { log({ t: "engine-swap", error: "libunity.so not loaded" }); return; }
    const size = regularFileSize(unity.path);
    if (size !== DONOR_SIZE) {
        log({ t: "engine-swap", full: false, size });
        return;
    }
    const target = unity.base.add(SCRIPTING_METHOD_INVOKE);
    const head = hex(target, 16);
    if (head !== PROLOGUE) {
        log({ t: "engine-swap", full: true, error: "prologue mismatch", head });
        return;
    }
    swapped = true;

    // CModule(TinyCC) 안의 전역 변수는 코드와 같은 읽기 전용 페이지에 놓여, 쓰면 SIGSEGV가 났다(2026-11-21 실측,
    // pc=<anonymous>+0x80, fault = 같은 페이지 +0x110). 쓰는 값은 전부 JS가 잡은 쓰기 가능한 메모리로 넘긴다.
    const slot = Memory.alloc(Process.pointerSize);   // 원본(트램펄린) 주소
    const skippedMem = Memory.alloc(4);
    const callerMem = Memory.alloc(Process.pointerSize);
    cm = new CModule(`
        typedef void * (*InvokeFn) (void * method, void * obj, void * args, void * exc, int convert);
        extern void * orig_slot;
        extern int skipped;
        extern void * last_skipped_caller;

        void * guard (void * method, void * obj, void * args, void * exc, int convert)
        {
          if (method == 0 || orig_slot == 0)
          {
            skipped++;
            last_skipped_caller = __builtin_return_address (0);
            return 0;
          }
          return ((InvokeFn) orig_slot) (method, obj, args, exc, convert);
        }
    `, { orig_slot: slot, skipped: skippedMem, last_skipped_caller: callerMem });
    const orig = Interceptor.replaceFast(target, cm.guard);
    slot.writePointer(orig);
    log({ t: "engine-swap", full: true, size, guard: "scripting_method_invoke", at: `libunity+0x${SCRIPTING_METHOD_INVOKE.toString(16)}` });

    // 건너뛴 호출 수를 가끔 남긴다 (게임 스레드, 가벼움)
    const skippedPtr = skippedMem;
    const callerPtr = callerMem;
    let lastLogged = 0, reports = 0, nextAt = 0;
    onFrame("engine-swap", () => {
        const now = Date.now();
        if (now < nextAt) return;
        nextAt = now + 10000;
        const n = skippedPtr.readS32();
        if (n === lastLogged || reports >= 20) return;
        reports++;
        const caller = callerPtr.readPointer();
        log({ t: "engine-swap-skipped", total: n, since: n - lastLogged,
            lastCaller: caller.isNull() ? null : `libunity+0x${caller.sub(unity.base).toString(16)}` });
        lastLogged = n;
    });
}
