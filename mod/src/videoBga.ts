// BGA를 Unity VideoPlayer로 배경에 깔기 (2026-11-21, 엔진 교체 실험 2단계).
// 엔진을 자르지 않은 2019.4.41f1 런타임으로 바꾼 APK(engineSwap.ts, donor/README.md)에서만 돈다.
// 게임 IL2CPP에는 VideoPlayer C# 클래스가 없으므로:
//  1) 도너 디버그 심볼로 찾은 엔진 함수로 네이티브 VideoPlayer를 만든다:
//       Unity::Type::FindTypeByName("VideoPlayer") → AddComponentUnchecked(GameObject&, Type*, NULL, NULL)
//  2) UnityEngine.Behaviour 객체를 생성자 없이 만들고 m_CachedPtr에 그 네이티브 포인터를 넣어 "가짜 래퍼"로 쓴다.
//     비디오 icall(il2cpp_resolve_icall로 얻은 주소)은 self의 m_CachedPtr만 읽는다.
//  3) 그리기: renderMode = RenderTexture. 영상이 준비되면(음악 시작 전) 영상 크기의 RenderTexture를 만들고,
//     Camera_2D에 붙인 Screen Space - Camera 캔버스(sortingOrder −100)의 전체 화면 RawImage에 띄운다.
//     스프라이트(배경 −70~−27, 노트 −15, 보스 −5)와 UI가 그 위에 그려진다. 같은 때 SceneObjectController/scene_XX(배경)의 크기를 0으로,
//     피버가 켜지면 FeverEffectManager.m_Background(피버 배경)를 끈다.
//     해 보고 안 된 것(2026-11-21 실측): ① targetCamera = Camera_2D + 먼 평면 → 스프라이트가 깊이를 안 써서 영상이 노트·점수·체력바를 덮음.
//     ② 영상 전용 카메라(depth −2, cullingMask 0 또는 31번 레이어)에 먼 평면·가까운 평면 → 영상 프레임은 진행하는데 화면엔 안 그려짐(검정).
//  4) 재생·싱크는 PC HwaSyncManager와 같다: 게임이 음악을 시작(FixedOffset)하고 BGM이 돌면 bgm.time으로 맞춰 Play,
//     0.1초마다 오차 > 20 ms면 재생 속도 ±15%, > 0.5초면 시크(2초 쉼). BGM이 멈추면 Pause.
// VideoPlayer는 네이티브 컴포넌트를 누가 GetComponents로 훑으면 엔진이 C# 래퍼를 만들려다 실패할 수 있어
// 아무도 안 보는 새 GameObject("hwa_bga")에 붙인다.
import { log } from "./log.js";
import { battleSerial, battleSong } from "./customChart.js";
import { onFrame } from "./frame.js";
import { findClass, gameClass, makeVector2, unityClass } from "./il2cpp.js";
import { nowUs } from "./native.js";
import { perfMark } from "./perf.js";
import { isFullEngine } from "./engineSwap.js";
import { currentConfig } from "./config.js";

const FIND_TYPE_BY_NAME = 0x41a274;      // Unity::Type::FindTypeByName(char const*, CaseSensitivityOptions)
const FIND_TYPE_PROLOGUE = "c89000f0086d44f93f040071e2179f1a";
const ADD_COMPONENT = 0x5039ec;          // AddComponentUnchecked(GameObject&, Unity::Type const*, ScriptingClassPtr, core::string*)
const ADD_COMPONENT_PROLOGUE = "f60f1df8f55301a9f37b02a9f30303aa";

const RENDER_TEXTURE = 2, SOURCE_URL = 1, AUDIO_NONE = 0, ASPECT_STRETCH = 5;
const CANVAS_SORTING_ORDER = -100;
const SYNC_MS = 100, SEEK_COOLDOWN_MS = 2000, SEEK_THRESHOLD = 0.5, SPEED_DEADBAND = 0.02, MAX_SPEED_DELTA = 0.15, REPORT_MS = 30000;

type Fn = NativeFunction<any, any[]>;
let api: Record<string, Fn> | null = null;
let findType: NativeFunction<NativePointer, [NativePointerValue, number]> | null = null;
let addComponent: NativeFunction<NativePointer, [NativePointerValue, NativePointerValue, NativePointerValue, NativePointerValue]> | null = null;

interface State {
    serial: number; wrapper: Il2Cpp.Object; handle: Il2Cpp.GCHandle; createdAt: number; camera2d: Il2Cpp.Object;
    prepared: boolean; shown: boolean; started: boolean; playing: boolean; speed: number; feverHidden: number;
    cooldownUntil: number; nextSync: number; length: number; diag: number; nextDiag: number;
    stats: { since: number; n: number; sum: number; max: number; seeks: number; costMax: number };
}
let st: State | null = null;
let musicStartedSerial = -1;
let triedSerial = -1;

const core = (n: string) => unityClass("UnityEngine.CoreModule", n);

function hex(p: NativePointer, n: number): string {
    return Array.from(new Uint8Array(p.readByteArray(n)!), x => x.toString(16).padStart(2, "0")).join("");
}

/** 엔진 함수·icall 주소를 한 번 푼다. 실패하면 false(이 기능 끔). */
function resolveApi(): boolean {
    if (api) return true;
    const unity = Process.findModuleByName("libunity.so")!;
    const ft = unity.base.add(FIND_TYPE_BY_NAME), ac = unity.base.add(ADD_COMPONENT);
    if (hex(ft, 16) !== FIND_TYPE_PROLOGUE || hex(ac, 16) !== ADD_COMPONENT_PROLOGUE) {
        log({ t: "vbga-error", error: "engine prologue mismatch" });
        return false;
    }
    findType = new NativeFunction(ft, "pointer", ["pointer", "int"]);
    addComponent = new NativeFunction(ac, "pointer", ["pointer", "pointer", "pointer", "pointer"]);
    const resolve = new NativeFunction(Il2Cpp.module.findExportByName("il2cpp_resolve_icall")!, "pointer", ["pointer"]);
    const sigs: Record<string, [string, string[]]> = {
        set_source: ["void", ["pointer", "int"]], set_url: ["void", ["pointer", "pointer"]],
        set_renderMode: ["void", ["pointer", "int"]], set_targetTexture: ["void", ["pointer", "pointer"]],
        set_aspectRatio: ["void", ["pointer", "int"]],
        set_audioOutputMode: ["void", ["pointer", "int"]], set_playOnAwake: ["void", ["pointer", "bool"]],
        set_isLooping: ["void", ["pointer", "bool"]], set_skipOnDrop: ["void", ["pointer", "bool"]],
        set_waitForFirstFrame: ["void", ["pointer", "bool"]], set_playbackSpeed: ["void", ["pointer", "float"]],
        set_time: ["void", ["pointer", "double"]], get_time: ["double", ["pointer"]], get_length: ["double", ["pointer"]],
        get_frame: ["int64", ["pointer"]], get_isPrepared: ["bool", ["pointer"]], get_isPlaying: ["bool", ["pointer"]],
        get_width: ["uint", ["pointer"]], get_height: ["uint", ["pointer"]],
        Prepare: ["void", ["pointer"]], Play: ["void", ["pointer"]], Pause: ["void", ["pointer"]], Stop: ["void", ["pointer"]]
    };
    const out: Record<string, Fn> = {};
    const missing: string[] = [];
    for (const [name, [ret, args]] of Object.entries(sigs)) {
        const p = resolve(Memory.allocUtf8String(`UnityEngine.Video.VideoPlayer::${name}`)) as NativePointer;
        if (p.isNull()) { missing.push(name); continue; }
        out[name] = new NativeFunction(p, ret as any, args as any);
    }
    if (missing.length) { log({ t: "vbga-error", error: "icall missing", missing }); return false; }
    api = out;
    return true;
}

const call = (name: string, ...args: any[]) => api![name](st!.wrapper.handle, ...args);

/** 인스턴스 메서드를 오버로드로 골라 그 객체에 묶는다(브리지 문서의 수동 바인딩). */
function bound<T extends Il2Cpp.Method.ReturnType>(cls: Il2Cpp.Class, name: string, types: string[], obj: Il2Cpp.Object): Il2Cpp.Method<T> {
    const m = cls.method<T>(name).overload(...types);
    // @ts-ignore bind는 타입 정의에 숨어 있다
    return m.bind(obj) as Il2Cpp.Method<T>;
}

function enumOf(cls: Il2Cpp.Class, value: number): Il2Cpp.ValueType {
    const v = cls.alloc().unbox();
    v.field("value__").value = value;
    return v;
}

function zeroVector3(): Il2Cpp.ValueType {
    const v = core("UnityEngine.Vector3").alloc().unbox();
    v.field("x").value = 0; v.field("y").value = 0; v.field("z").value = 0;
    return v;
}

function newGameObject(name: string): Il2Cpp.Object {
    const go = core("UnityEngine.GameObject").alloc();
    go.method(".ctor", 1).invoke(Il2Cpp.string(name));
    return go;
}

function sceneBackground(): Il2Cpp.Object[] {
    const GameObject = core("UnityEngine.GameObject");
    const soc = GameObject.method<Il2Cpp.Object>("Find", 1).invoke(Il2Cpp.string("SceneObjectController"));
    if (!soc || soc.isNull()) return [];
    const tr = soc.method<Il2Cpp.Object>("get_transform").invoke();
    const n = tr.method<number>("get_childCount").invoke();
    const out: Il2Cpp.Object[] = [];
    for (let i = 0; i < n; i++) {
        const go = tr.method<Il2Cpp.Object>("GetChild").invoke(i).method<Il2Cpp.Object>("get_gameObject").invoke();
        const name = go.method<Il2Cpp.String>("get_name").invoke().content ?? "";
        if (/^scene_\d+/.test(name)) out.push(go);
    }
    return out;
}

function create(path: string): void {
    const t0 = nowUs();
    const GameObject = core("UnityEngine.GameObject");
    const cameraGo = GameObject.method<Il2Cpp.Object>("Find", 1).invoke(Il2Cpp.string("Camera_2D"));
    if (!cameraGo || cameraGo.isNull()) { log({ t: "vbga-error", error: "Camera_2D not found" }); return; }
    const camera2d = bound<Il2Cpp.Object>(GameObject, "GetComponent", ["System.Type"], cameraGo).invoke(core("UnityEngine.Camera").type.object);
    if (!camera2d || camera2d.isNull()) { log({ t: "vbga-error", error: "Camera_2D has no Camera" }); return; }

    const go = newGameObject("hwa_bga");
    const nativeGo = go.field<NativePointer>("m_CachedPtr").value;
    const type = findType!(Memory.allocUtf8String("VideoPlayer"), 0);
    if (type.isNull()) { log({ t: "vbga-error", error: "type VideoPlayer not found" }); return; }
    const comp = addComponent!(nativeGo, type, NULL, NULL);
    if (comp.isNull()) { log({ t: "vbga-error", error: "AddComponentUnchecked returned null" }); return; }

    const wrapper = core("UnityEngine.Behaviour").alloc();          // 생성자 없이 (m_CachedPtr만 쓴다)
    wrapper.field<NativePointer>("m_CachedPtr").value = comp;
    const handle = wrapper.ref(true);
    st = { serial: battleSerial(), wrapper, handle, createdAt: Date.now(), camera2d, prepared: false, shown: false, started: false, playing: false, feverHidden: 0,
        speed: 1, cooldownUntil: 0, nextSync: 0, length: 0, diag: 0, nextDiag: 0, stats: { since: 0, n: 0, sum: 0, max: 0, seeks: 0, costMax: 0 } };

    call("set_playOnAwake", 0);
    call("set_source", SOURCE_URL);
    call("set_url", Il2Cpp.string(path).handle);
    call("set_renderMode", RENDER_TEXTURE);
    call("set_aspectRatio", ASPECT_STRETCH);          // RenderTexture를 영상 크기로 만드니 늘리기 = 그대로, 화면 비는 RawImage uvRect로 맞춘다
    call("set_audioOutputMode", AUDIO_NONE);
    call("set_isLooping", 1);
    call("set_skipOnDrop", 1);
    call("set_waitForFirstFrame", 1);
    call("Prepare");
    log({ t: "vbga-created", path, type: type.toString(), component: comp.toString(), ms: Math.round((nowUs() - t0) / 1000) });
}

/** 영상 크기의 RenderTexture를 만들어 VideoPlayer 출력으로 걸고, Camera_2D 캔버스(sortingOrder −100)의 전체 화면 RawImage에 띄운다. */
function attachDisplay(width: number, height: number): object {
    const RenderTexture = core("UnityEngine.RenderTexture");
    const rt = RenderTexture.alloc();
    rt.method(".ctor").overload("System.Int32", "System.Int32", "System.Int32").invoke(width, height, 0);
    rt.method("Create").invoke();
    call("set_targetTexture", rt.handle);

    const ui = (n: string) => unityClass("UnityEngine.UIModule", n);
    const GameObject = core("UnityEngine.GameObject");
    const Canvas = ui("UnityEngine.Canvas");
    const canvasGo = newGameObject("hwa_bga_canvas");
    const canvas = bound<Il2Cpp.Object>(GameObject, "AddComponent", ["System.Type"], canvasGo).invoke(Canvas.type.object);
    canvas.method("set_renderMode").invoke(enumOf(Canvas.method("get_renderMode").returnType.class, 1));   // ScreenSpaceCamera
    canvas.method("set_worldCamera").invoke(st!.camera2d);
    const far = st!.camera2d.method<number>("get_farClipPlane").invoke();
    const near = st!.camera2d.method<number>("get_nearClipPlane").invoke();
    canvas.method("set_planeDistance").invoke(Math.max(near + 1, far * 0.9));
    canvas.method("set_sortingOrder").invoke(CANVAS_SORTING_ORDER);

    const RawImage = unityClass("UnityEngine.UI", "UnityEngine.UI.RawImage");
    const imageGo = newGameObject("hwa_bga_image");
    const image = bound<Il2Cpp.Object>(GameObject, "AddComponent", ["System.Type"], imageGo).invoke(RawImage.type.object);
    const rect = imageGo.method<Il2Cpp.Object>("get_transform").invoke();   // RawImage가 RectTransform으로 바꿔 놓음
    rect.method("SetParent").overload("UnityEngine.Transform", "System.Boolean").invoke(canvasGo.method<Il2Cpp.Object>("get_transform").invoke(), false);
    rect.method("set_anchorMin").invoke(makeVector2(0, 0));
    rect.method("set_anchorMax").invoke(makeVector2(1, 1));
    rect.method("set_offsetMin").invoke(makeVector2(0, 0));
    rect.method("set_offsetMax").invoke(makeVector2(0, 0));
    image.method("set_texture").invoke(rt);
    image.method("set_raycastTarget").invoke(false);

    // 화면을 꽉 채우고 넘치는 쪽을 자른다(Fit Outside): 화면이 더 넓으면 위아래를, 더 높으면 좌우를 자른다.
    const Screen = core("UnityEngine.Screen");
    const sw = Screen.method<number>("get_width").invoke(), sh = Screen.method<number>("get_height").invoke();
    const screenAspect = sw / sh, videoAspect = width / height;
    let u = 0, v = 0, uw = 1, vh = 1;
    if (screenAspect > videoAspect) { vh = videoAspect / screenAspect; v = (1 - vh) / 2; }
    else { uw = screenAspect / videoAspect; u = (1 - uw) / 2; }
    const Rect = core("UnityEngine.Rect");
    const r = Rect.alloc().unbox();
    r.field("m_XMin").value = u; r.field("m_YMin").value = v; r.field("m_Width").value = uw; r.field("m_Height").value = vh;
    image.method("set_uvRect").invoke(r);
    return { rt: `${width}x${height}`, screen: `${sw}x${sh}`, uv: [u, v, uw, vh].map(x => Math.round(x * 1000) / 1000), planeDistance: Math.max(near + 1, far * 0.9) };
}

function release(why: string): void {
    if (!st) return;
    try { if (api) call("Stop"); } catch (e) { /* 이미 사라짐 */ }
    try { st.wrapper.field<NativePointer>("m_CachedPtr").value = NULL; } catch (e) { /* 무시 */ }
    try { st.handle.free(); } catch (e) { /* 무시 */ }
    log({ t: "vbga-stopped", why, serial: st.serial });
    st = null;
}

export function installVideoBga(): void {
    if (!isFullEngine()) { log({ t: "vbga-off", reason: "stripped engine" }); return; }
    if (!resolveApi()) return;
    const Stage = gameClass("FormulaBase.StageBattleComponent");
    const AudioManager = gameClass("Assets.Scripts.PeroTools.Managers.AudioManager");
    const GameObject = core("UnityEngine.GameObject");
    let bgmPtr: NativePointer | null = null, bgmSerial = -1;
    let getTime: NativeFunction<number, [NativePointerValue, NativePointerValue]> | null = null;
    let getIsPlaying: NativeFunction<number, [NativePointerValue, NativePointerValue]> | null = null;
    const bgm = (): NativePointer | null => {
        if (bgmSerial === battleSerial() && bgmPtr) return bgmPtr;
        const s = AudioManager.method<Il2Cpp.Object>("get_instance").invoke()?.method<Il2Cpp.Object>("get_bgm").invoke();
        if (!s || s.isNull()) return null;
        if (!getTime) {
            getTime = new NativeFunction(s.method("get_time", 0).virtualAddress, "float", ["pointer", "pointer"]);
            getIsPlaying = new NativeFunction(s.method("get_isPlaying", 0).virtualAddress, "uint8", ["pointer", "pointer"]);
        }
        bgmPtr = s.handle; bgmSerial = battleSerial();
        return bgmPtr;
    };

    Interceptor.attach(Stage.method("FixedOffset").virtualAddress, { onLeave() { if (battleSong()) musicStartedSerial = battleSerial(); } });
    Interceptor.attach(Stage.method("End").virtualAddress, { onEnter() { release("end"); } });
    Interceptor.attach(Stage.method("Exit", 3).virtualAddress, { onEnter() { release("exit"); } });

    // 피버: FeverEffectManager가 자기 배경(m_Background, 0x28)을 화면에 밀어 넣어 영상을 가린다(2026-11-21 사용자 제보).
    // 영상 BGA가 화면에 떠 있으면 그 배경만 끈다(파티클·번쩍임·색 반전은 그대로). 피버가 켜질 때마다 다시 확인한다.
    const Fever = findClass("FeverEffectManager");
    if (Fever) {
        const hideFeverBg = (self: NativePointer, where: string) => {
            if (!st || !st.shown) return;
            try {
                const bg = new Il2Cpp.Object(self).field<Il2Cpp.Object>("m_Background").value;
                if (!bg || bg.isNull()) return;
                const was = bg.method<boolean>("get_activeSelf").invoke();
                if (was) bg.method("SetActive").invoke(false);
                if (st.feverHidden++ < 4) log({ t: "vbga-fever-bg", where, wasActive: was, name: bg.method<Il2Cpp.String>("get_name").invoke().content });
            } catch (e) { log({ t: "vbga-error", error: `fever: ${e}` }); }
        };
        for (const [name, argc] of [["ActivateFever", 1], ["InvokeNormalFever", 0], ["InvokeBadAppleFever", 0]] as [string, number][]) {
            const m = Fever.tryMethod(name, argc);
            if (!m) continue;
            Interceptor.attach(m.virtualAddress, {
                onEnter(args) { (this as any).self = args[0]; },
                onLeave() { hideFeverBg((this as any).self, name); }
            });
        }
    } else {
        log({ t: "vbga-error", error: "FeverEffectManager not found" });
    }

    onFrame("video-bga", () => {
        const serial = battleSerial();
        if (st && st.serial !== serial) release("new-battle");
        const song = battleSong();
        if (!song || !song.videoPath || song.manifest.cinema === false || currentConfig.enableCinema === false) return;

        // 배틀 씬이 올라온 첫 프레임에 만든다 (hitpoints·bgaProbe와 같은 기준)
        if (!st && triedSerial !== serial) {
            const soc = GameObject.method<Il2Cpp.Object>("Find", 1).invoke(Il2Cpp.string("SceneObjectController"));
            if (!soc || soc.isNull()) return;
            triedSerial = serial;
            try { create(song.videoPath); } catch (e) { log({ t: "vbga-error", error: `create: ${e}` }); st = null; }
            return;
        }
        if (!st) return;
        const now = Date.now();
        if (now < st.nextSync) return;
        st.nextSync = now + SYNC_MS;
        const t0 = nowUs();

        if (!st.prepared) {
            if (!call("get_isPrepared")) {
                if (now - st.createdAt > 20000 && st.stats.since === 0) { st.stats.since = -1; log({ t: "vbga-error", error: "not prepared after 20s" }); }
                return;
            }
            st.prepared = true;
            st.length = call("get_length");
            const w = call("get_width") as number, h = call("get_height") as number;
            log({ t: "vbga-prepared", afterMs: now - st.createdAt, length: st.length, width: w, height: h });
            // 화면 연결과 배경 끄기는 음악 시작 전(레디·고 동안)에 한다.
            // 음악이 시작된 뒤에 배경을 끄면 scene_04(렌더러 332개) SetActive(false)에 599 ms가 걸려 첫 박자가 멈췄다(2026-11-21 실측).
            const h0 = nowUs();
            let display: object | string;
            try { display = attachDisplay(w || 1920, h || 1080); } catch (e) { display = `error: ${e}`; }
            const d1 = nowUs();
            const bg = typeof display === "string" ? [] : sceneBackground();   // 화면 연결이 실패하면 원래 배경을 남긴다
            // SetActive(false)는 렌더러 332개에 OnDisable이 돌아 614 ms가 걸렸다(2026-11-21 실측) → 루트 크기만 0으로(트랜스폼 하나).
            for (const go of bg) go.method<Il2Cpp.Object>("get_transform").invoke().method("set_localScale").invoke(zeroVector3());
            st.shown = typeof display !== "string";
            log({ t: "vbga-display", display, displayMs: Math.round((d1 - h0) / 1000),
                hidden: bg.map(g => g.method<Il2Cpp.String>("get_name").invoke().content), hideMs: Math.round((nowUs() - d1) / 1000),
                musicStarted: musicStartedSerial === serial });
            return;
        }
        if (musicStartedSerial !== serial) return;
        const src = bgm();
        if (!src || !getTime || !getIsPlaying) return;
        const bgmPlaying = getIsPlaying(src, NULL) !== 0;
        const master = getTime(src, NULL);
        const expected = st.length > 0.5 ? master % st.length : master;

        if (!bgmPlaying) {
            if (st.playing) { call("Pause"); st.playing = false; log({ t: "vbga-paused", bgmTime: master }); }
            return;
        }
        if (!st.playing) {
            call("set_time", expected);
            call("set_playbackSpeed", 1.0); st.speed = 1;
            call("Play");
            st.playing = true;
            st.cooldownUntil = now + SEEK_COOLDOWN_MS;
            st.stats = { since: now, n: 0, sum: 0, max: 0, seeks: 0, costMax: 0 };
            log({ t: st.started ? "vbga-resumed" : "vbga-started", bgmTime: master, videoTime: expected });
            st.started = true;
            return;
        }
        const vt = call("get_time") as number;
        let diff = vt - expected;
        if (st.length > 0.5) { if (diff > st.length / 2) diff -= st.length; else if (diff < -st.length / 2) diff += st.length; }
        if (now >= st.cooldownUntil) {
            const abs = Math.abs(diff);
            st.stats.n++; st.stats.sum += abs; if (abs > st.stats.max) st.stats.max = abs;
            if (abs > SEEK_THRESHOLD) {
                log({ t: "vbga-seek", diff: Math.round(diff * 1000) / 1000, video: vt, bgm: expected });
                call("set_playbackSpeed", 1.0); st.speed = 1;
                call("set_time", expected);
                st.cooldownUntil = now + SEEK_COOLDOWN_MS;
                st.stats.seeks++;
            } else {
                const target = abs <= SPEED_DEADBAND ? 1 : 1 - Math.min(MAX_SPEED_DELTA, Math.max(-MAX_SPEED_DELTA, diff));
                if (Math.abs(target - st.speed) > 0.005) { call("set_playbackSpeed", target); st.speed = target; }
            }
        }
        if (st.diag < 3 && now >= st.nextDiag) {
            st.diag++; st.nextDiag = now + 2000;
            log({ t: "vbga-diag", n: st.diag, videoTime: vt, bgmTime: master, frame: Number(call("get_frame")), isPlaying: call("get_isPlaying") });
        }
        const us = nowUs() - t0;
        if (us > st.stats.costMax) st.stats.costMax = us;
        if (us > 1000) perfMark(`vbga:${(us / 1000).toFixed(1)}`);
        if (st.stats.since > 0 && now - st.stats.since >= REPORT_MS && st.stats.n > 0) {
            log({ t: "vbga-drift", seconds: Math.round((now - st.stats.since) / 1000), avgMs: Math.round(st.stats.sum / st.stats.n * 1000),
                maxMs: Math.round(st.stats.max * 1000), seeks: st.stats.seeks, speed: st.speed, costMaxUs: st.stats.costMax });
            st.stats = { since: now, n: 0, sum: 0, max: 0, seeks: 0, costMax: 0 };
        }
    });
    log({ t: "vbga-ready" });
}
