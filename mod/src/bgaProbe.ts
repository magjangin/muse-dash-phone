// BGA 실현 가능성 진단 (2026-11-21). 재생은 bga.ts에서 꺼 두고, 배틀 씬에 들어갈 때 "영상을 게임 배경으로 깔 수 있는가"를
// 판단할 재료만 로그로 남긴다. 아무것도 바꾸지 않는다(읽기만).
//
// 배경으로 까는 길은 두 가지다:
//  (A) Unity 화면 층을 투명하게: UnityPlayer.CreateGlView가 창 테마가 반투명(IsWindowTranslucent)이면
//      setFormat(TRANSLUCENT)+setZOrderOnTop(true), 아니면 OPAQUE로 만든다(jadx UnityPlayer.java:394).
//      그 뒤 배경 오브젝트를 끄고 카메라 배경 알파를 0으로 하면 아래의 영상 SurfaceView가 비친다.
//      → 필요한 것: EGL 설정에 알파 비트(EGL_ALPHA_SIZE > 0), 마지막 카메라가 화면에 직접 그리는지(targetTexture 없음),
//        카메라 clearFlags/배경색, 배경 오브젝트가 무엇인지.
//  (B) 영상을 Unity 텍스처로: MediaPlayer → SurfaceTexture(GL_TEXTURE_EXTERNAL_OES) → Texture2D.CreateExternalTexture.
//      → 필요한 것: 그래픽 API(GLES3/Vulkan), CreateExternalTexture가 스트리핑되지 않았는지, OES를 읽는 셰이더가 있는지.
//
// 로그(전부 t: "bga-probe-*"):
//  - bga-probe-android: 창·액티비티 하드웨어 가속, 테마 반투명, Unity SurfaceView, 영상 메타데이터 (스크립트 스레드, 프로세스당 1번)
//  - bga-probe-egl: 실제 화면 EGL 설정(알파·RGB 비트, 네이티브 픽셀 형식) (렌더 스레드에서 eglSwapBuffers 1번 엿봄)
//  - bga-probe-unity: 그래픽 API·VideoModule·외부 텍스처 API·셰이더 (프로세스당 1번)
//  - bga-probe-scene: 카메라 목록과 SceneObjectController 아래 배경 후보 (배틀 진입마다, 프로세스당 최대 MAX_SCENE_DUMPS번)
import Java from "frida-java-bridge";
import { log } from "./log.js";
import { battleSerial, battleSong } from "./customChart.js";
import { onFrame } from "./frame.js";
import { findClass, unityClass } from "./il2cpp.js";
import { nowUs } from "./native.js";

const MAX_SCENE_DUMPS = 3;
const MAX_CHILDREN = 40;
const MAX_RENDERERS_PER_CHILD = 3;
const EGL_WAIT_MS = 5000;

let staticDone = false;
let sceneDumps = 0;
let lastSerial = -1;

// ---------- Android (스크립트 스레드) ----------

function probeAndroid(videoPath: string | null): void {
    if (!Java.available) { log({ t: "bga-probe-android", error: "Java not available" }); return; }
    const out: Record<string, unknown> = {};
    Java.performNow(() => {
        const step = (name: string, fn: () => unknown) => {
            try { out[name] = fn(); } catch (e) { out[name] = `error: ${e}`; }
        };
        const activity = Java.use("com.unity3d.player.UnityPlayer").currentActivity.value;
        if (!activity) { out.error = "no activity"; return; }
        step("window", () => {
            const attrs = activity.getWindow().getAttributes();
            const flags = attrs.flags.value as number;
            return { hwAccelerated: (flags & 0x01000000) !== 0, format: attrs.format.value, flags: `0x${(flags >>> 0).toString(16)}` };
        });
        step("activityInfo", () => {
            const ai = activity.getPackageManager().getActivityInfo(activity.getComponentName(), 0);
            const f = ai.flags.value as number;
            return { hwAccelerated: (f & 0x200) !== 0, theme: `0x${(ai.getThemeResource() >>> 0).toString(16)}` };
        });
        step("themeTranslucent", () => {
            const tv = Java.use("android.util.TypedValue").$new();
            const found = activity.getTheme().resolveAttribute(0x01010058, tv, true); // android.R.attr.windowIsTranslucent
            return { found, type: tv.type.value, data: tv.data.value };
        });
        step("unityPlayer", () => {
            const up = Java.cast(activity, Java.use("com.unity3d.player.UnityPlayerActivity")).mUnityPlayer.value;
            if (!up) return null;
            const res: Record<string, unknown> = { class: up.getClass().getName() };
            try { res.isWindowTranslucent = up.IsWindowTranslucent(); } catch (e) { res.isWindowTranslucent = `error: ${e}`; }
            return res;
        });
        step("unitySurfaceView", () => {
            const id = activity.getResources().getIdentifier("unitySurfaceView", "id", activity.getPackageName());
            const v = id ? activity.findViewById(id) : null;
            if (!v) return { id, found: false };
            const sv = Java.cast(v, Java.use("android.view.SurfaceView"));
            const res: Record<string, unknown> = { id, found: true, w: sv.getWidth(), h: sv.getHeight(), opaqueView: sv.isOpaque() };
            // SurfaceView.mRequestedFormat는 숨은 API라 막혀 있을 수 있다.
            try { res.requestedFormat = sv.mRequestedFormat.value; } catch (e) { res.requestedFormat = `blocked: ${e}`; }
            try {
                const sc = sv.getSurfaceControl();
                res.surfaceControl = sc ? sc.toString() : null;
            } catch (e) { res.surfaceControl = `error: ${e}`; }
            return res;
        });
        step("contentChildren", () => {
            const content = Java.cast(activity.findViewById(16908290), Java.use("android.view.ViewGroup"));
            const list: string[] = [];
            const walk = (g: any, depth: number) => {
                const n = g.getChildCount();
                for (let i = 0; i < n && list.length < 20; i++) {
                    const c = g.getChildAt(i);
                    list.push(`${"-".repeat(depth)}${c.getClass().getName()}`);
                    if (depth < 3 && Java.use("android.view.ViewGroup").class.isInstance(c)) walk(Java.cast(c, Java.use("android.view.ViewGroup")), depth + 1);
                }
            };
            walk(content, 0);
            return list;
        });
        step("windowBackground", () => {
            const d = activity.getWindow().getDecorView().getBackground();
            return d ? `${d.getClass().getName()} opacity=${d.getOpacity()}` : null;
        });
        if (videoPath) {
            step("video", () => {
                const mmr = Java.use("android.media.MediaMetadataRetriever").$new();
                try {
                    mmr.setDataSource(videoPath);
                    const k = (key: number) => { try { return mmr.extractMetadata(key); } catch (e) { return null; } };
                    return { path: videoPath, width: k(18), height: k(19), rotation: k(24), durationMs: k(9), mime: k(12), hasAudio: k(16), hasVideo: k(17), bitrate: k(20), frameCount: k(32) };
                } finally {
                    try { mmr.release(); } catch (e) { /* 무시 */ }
                }
            });
        }
    });
    log({ t: "bga-probe-android", ...out });
}

// ---------- EGL (렌더 스레드에서 한 번) ----------

function probeEgl(): void {
    const egl = Process.findModuleByName("libEGL.so");
    if (!egl) { log({ t: "bga-probe-egl", error: "libEGL.so not loaded" }); return; }
    const exp = (n: string) => egl.findExportByName(n);
    const querySurface = exp("eglQuerySurface"), chooseConfig = exp("eglChooseConfig"), getConfigAttrib = exp("eglGetConfigAttrib");
    const getCurrentContext = exp("eglGetCurrentContext"), queryContext = exp("eglQueryContext");
    if (!querySurface || !chooseConfig || !getConfigAttrib) { log({ t: "bga-probe-egl", error: "egl exports missing" }); return; }
    const fQuerySurface = new NativeFunction(querySurface, "uint", ["pointer", "pointer", "int", "pointer"]);
    const fChooseConfig = new NativeFunction(chooseConfig, "uint", ["pointer", "pointer", "pointer", "int", "pointer"]);
    const fGetConfigAttrib = new NativeFunction(getConfigAttrib, "uint", ["pointer", "pointer", "int", "pointer"]);
    const fGetCurrentContext = getCurrentContext ? new NativeFunction(getCurrentContext, "pointer", []) : null;
    const fQueryContext = queryContext ? new NativeFunction(queryContext, "uint", ["pointer", "pointer", "int", "pointer"]) : null;

    let done = false;
    const listeners: InvocationListener[] = [];
    const finish = () => { setTimeout(() => { for (const l of listeners) { try { l.detach(); } catch (e) { /* 이미 뗌 */ } } }, 0); };
    const onSwap = (dpy: NativePointer, surf: NativePointer, which: string) => {
        if (done) return;
        done = true;
        const res: Record<string, unknown> = { via: which, thread: Process.getCurrentThreadId() };
        try {
            const v = Memory.alloc(4);
            fQuerySurface(dpy, surf, 0x3028, v);               // EGL_CONFIG_ID
            const id = v.readS32();
            res.configId = id;
            const attribs = Memory.alloc(12);
            attribs.writeS32(0x3028); attribs.add(4).writeS32(id); attribs.add(8).writeS32(0x3038); // EGL_NONE
            const cfg = Memory.alloc(8), n = Memory.alloc(4);
            fChooseConfig(dpy, attribs, cfg, 1, n);
            const config = cfg.readPointer();
            const attr = (a: number) => { fGetConfigAttrib(dpy, config, a, v); return v.readS32(); };
            res.red = attr(0x3024); res.green = attr(0x3023); res.blue = attr(0x3022); res.alpha = attr(0x3021);
            res.depth = attr(0x3025); res.stencil = attr(0x3026); res.samples = attr(0x3031);
            res.nativeVisualId = attr(0x302E);                 // Android 픽셀 형식: 1 RGBA_8888, 2 RGBX_8888, 4 RGB_565
            res.renderableType = `0x${attr(0x3040).toString(16)}`;
            for (const [name, key] of [["width", 0x3057], ["height", 0x3056]] as [string, number][]) {
                fQuerySurface(dpy, surf, key, v); res[name] = v.readS32();
            }
            if (fGetCurrentContext && fQueryContext) {
                const ctx = fGetCurrentContext();
                fQueryContext(dpy, ctx, 0x3098, v);            // EGL_CONTEXT_CLIENT_VERSION
                res.contextClientVersion = v.readS32();
            }
        } catch (e) {
            res.error = `${e}`;
        }
        log({ t: "bga-probe-egl", ...res });
        finish();
    };
    for (const name of ["eglSwapBuffers", "eglSwapBuffersWithDamageKHR"]) {
        const p = exp(name);
        if (!p) continue;
        listeners.push(Interceptor.attach(p, { onEnter(args) { onSwap(args[0], args[1], name); } }));
    }
    setTimeout(() => {
        if (done) return;
        done = true;
        log({ t: "bga-probe-egl", none: true, waitedMs: EGL_WAIT_MS, note: "eglSwapBuffers가 안 불림 (Vulkan이면 정상)" });
        finish();
    }, EGL_WAIT_MS);
}

// ---------- Unity (게임 스레드) ----------

const nameOf = (o: Il2Cpp.Object | null): string | null => {
    if (!o || o.isNull()) return null;
    try { return o.method<Il2Cpp.String>("get_name").invoke().content ?? null; } catch (e) { return null; }
};
const enumValue = (v: unknown): unknown => {
    try { return (v as Il2Cpp.ValueType).field("value__").value; } catch (e) { return `${v}`; }
};
const round = (x: number) => Math.round(x * 1000) / 1000;

function probeUnityStatic(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const step = (name: string, fn: () => unknown) => { try { out[name] = fn(); } catch (e) { out[name] = `error: ${e}`; } };
    step("graphics", () => {
        const SI = unityClass("UnityEngine.CoreModule", "UnityEngine.SystemInfo");
        const get = (m: string) => { try { return SI.method(m).invoke(); } catch (e) { return `error: ${e}`; } };
        const s = (v: unknown) => (v instanceof Il2Cpp.String ? v.content : v);
        return {
            deviceType: enumValue(get("get_graphicsDeviceType")),   // 8 OpenGLES2, 11 OpenGLES3, 21 Vulkan
            version: s(get("get_graphicsDeviceVersion")),
            name: s(get("get_graphicsDeviceName")),
            multiThreaded: get("get_graphicsMultiThreaded"),
            maxTextureSize: get("get_maxTextureSize")
        };
    });
    step("videoModule", () => Il2Cpp.domain.tryAssembly("UnityEngine.VideoModule") !== null);
    // 엔진(libunity.so)이 비디오 내부 함수(icall)를 IL2CPP에 등록했는지. 게임 원래 libunity는 비디오가 잘려 0개였고,
    // 같은 버전(2019.4.41f1 fb553f8fdd6c)의 자르지 않은 libunity로 바꾸면 여기서 주소가 나와야 한다(엔진 교체 실험).
    step("videoIcalls", () => {
        const resolve = Il2Cpp.module.findExportByName("il2cpp_resolve_icall");
        if (!resolve) return "no il2cpp_resolve_icall";
        const f = new NativeFunction(resolve, "pointer", ["pointer"]);
        const unity = Process.findModuleByName("libunity.so");
        const res: Record<string, string | null> = {};
        for (const n of ["UnityEngine.AudioSource::GetPitch", "UnityEngine.Video.VideoPlayer::Play", "UnityEngine.Video.VideoPlayer::Prepare",
            "UnityEngine.Video.VideoPlayer::set_url", "UnityEngine.Video.VideoPlayer::get_isPrepared", "UnityEngine.Video.VideoPlayer::set_renderMode",
            "UnityEngine.Video.VideoPlayer::set_targetTexture", "UnityEngine.Video.VideoPlayer::get_time"]) {
            const p = f(Memory.allocUtf8String(n));
            res[n] = p.isNull() ? null : (unity && p.compare(unity.base) >= 0 && p.compare(unity.base.add(unity.size)) < 0 ? `libunity+0x${p.sub(unity.base).toString(16)}` : p.toString());
        }
        return { libunitySize: unity?.size ?? null, libunityPath: unity?.path ?? null, icalls: res };
    });
    step("externalTexture", () => {
        const T2D = unityClass("UnityEngine.CoreModule", "UnityEngine.Texture2D");
        return {
            createExternalTexture: T2D.tryMethod("CreateExternalTexture") !== null,
            updateExternalTexture: T2D.tryMethod("UpdateExternalTexture") !== null,
            getNativeTexturePtr: findClass("UnityEngine.Texture")?.tryMethod("GetNativeTexturePtr") !== null
        };
    });
    step("shaders", () => {
        const Shader = unityClass("UnityEngine.CoreModule", "UnityEngine.Shader");
        const res: Record<string, boolean> = {};
        for (const n of ["Unlit/Texture", "Unlit/Transparent", "Sprites/Default", "UI/Default", "Hidden/BlitCopy", "Spine/Skeleton", "Spine/Skeleton Tint"]) {
            try {
                const sh = Shader.method<Il2Cpp.Object>("Find", 1).invoke(Il2Cpp.string(n));
                res[n] = !!sh && !sh.isNull();
            } catch (e) { res[n] = false; }
        }
        return res;
    });
    step("screen", () => {
        const Screen = unityClass("UnityEngine.CoreModule", "UnityEngine.Screen");
        const QS = unityClass("UnityEngine.CoreModule", "UnityEngine.QualitySettings");
        return {
            width: Screen.method("get_width").invoke(), height: Screen.method("get_height").invoke(),
            antiAliasing: QS.method("get_antiAliasing").invoke()
        };
    });
    return out;
}

function probeCameras(): unknown[] {
    const Camera = unityClass("UnityEngine.CoreModule", "UnityEngine.Camera");
    const Component = unityClass("UnityEngine.CoreModule", "UnityEngine.Component");
    let cams: Il2Cpp.Object[] = [];
    const all = Camera.tryMethod<Il2Cpp.Array<Il2Cpp.Object>>("get_allCameras");
    if (all) {
        const arr = all.invoke();
        for (let i = 0; i < arr.length; i++) cams.push(arr.get(i));
    } else {
        const main = Camera.method<Il2Cpp.Object>("get_main").invoke();
        if (main && !main.isNull()) cams = [main];
    }
    return cams.map(c => {
        const r: Record<string, unknown> = { name: nameOf(c) };
        const get = (m: string) => { try { return c.method(m).invoke(); } catch (e) { return `error: ${e}`; } };
        r.enabled = get("get_enabled");
        r.depth = get("get_depth");
        r.clearFlags = enumValue(get("get_clearFlags"));   // 1 Skybox, 2 SolidColor, 3 Depth, 4 Nothing
        try {
            const bg = c.method<Il2Cpp.ValueType>("get_backgroundColor").invoke();
            r.background = ["r", "g", "b", "a"].map(k => round(bg.field<number>(k).value));
        } catch (e) { r.background = `error: ${e}`; }
        try {
            const rt = c.method<Il2Cpp.Object>("get_targetTexture").invoke();
            r.targetTexture = rt && !rt.isNull() ? nameOf(rt) ?? "(unnamed)" : null;
        } catch (e) { r.targetTexture = `error: ${e}`; }
        r.cullingMask = get("get_cullingMask");
        r.orthographic = get("get_orthographic");
        try {
            const go = c.method<Il2Cpp.Object>("get_gameObject").invoke();
            const comps = go.method<Il2Cpp.Array<Il2Cpp.Object>>("GetComponents", 1).invoke(Component.type.object);
            const names: string[] = [];
            for (let i = 0; i < comps.length; i++) { const k = comps.get(i); if (k && !k.isNull()) names.push(k.class.name); }
            r.components = names;
        } catch (e) { r.components = `error: ${e}`; }
        return r;
    });
}

function probeBackground(): unknown {
    const GameObject = unityClass("UnityEngine.CoreModule", "UnityEngine.GameObject");
    const Renderer = unityClass("UnityEngine.CoreModule", "UnityEngine.Renderer");
    const soc = GameObject.method<Il2Cpp.Object>("Find", 1).invoke(Il2Cpp.string("SceneObjectController"));
    if (!soc || soc.isNull()) return { found: false };
    const tr = soc.method<Il2Cpp.Object>("get_transform").invoke();
    const count = tr.method<number>("get_childCount").invoke();
    const getInChildren = GameObject.method<Il2Cpp.Array<Il2Cpp.Object>>("GetComponentsInChildren").overload("System.Type", "System.Boolean");
    const children: unknown[] = [];
    for (let i = 0; i < count && i < MAX_CHILDREN; i++) {
        const child = tr.method<Il2Cpp.Object>("GetChild").invoke(i);
        const go = child.method<Il2Cpp.Object>("get_gameObject").invoke();
        const c: Record<string, unknown> = { name: nameOf(go), active: go.method("get_activeSelf").invoke(), layer: go.method("get_layer").invoke() };
        try {
            // 브리지 문서대로 수동 바인딩 (bind는 타입 정의에 숨어 있음)
            // @ts-ignore
            const rends = (getInChildren.bind(go) as Il2Cpp.Method<Il2Cpp.Array<Il2Cpp.Object>>).invoke(Renderer.type.object, true);
            c.renderers = rends.length;
            let minOrder = Infinity, maxOrder = -Infinity;
            const layers = new Set<string>();
            const samples: unknown[] = [];
            for (let j = 0; j < rends.length; j++) {
                const rd = rends.get(j);
                const order = rd.method<number>("get_sortingOrder").invoke();
                if (order < minOrder) minOrder = order;
                if (order > maxOrder) maxOrder = order;
                try { layers.add(rd.method<Il2Cpp.String>("get_sortingLayerName").invoke().content ?? ""); } catch (e) { /* 무시 */ }
                if (samples.length < MAX_RENDERERS_PER_CHILD) {
                    let shader: string | null = null;
                    try { shader = nameOf(rd.method<Il2Cpp.Object>("get_sharedMaterial").invoke()?.method<Il2Cpp.Object>("get_shader").invoke() ?? null); } catch (e) { /* 무시 */ }
                    samples.push({ go: nameOf(rd.method<Il2Cpp.Object>("get_gameObject").invoke()), type: rd.class.name, order, shader });
                }
            }
            if (rends.length > 0) { c.order = [minOrder, maxOrder]; c.sortingLayers = [...layers]; c.samples = samples; }
        } catch (e) { c.renderers = `error: ${e}`; }
        children.push(c);
    }
    return { found: true, childCount: count, children };
}

export function installBgaProbe(): void {
    const GameObject = unityClass("UnityEngine.CoreModule", "UnityEngine.GameObject");
    onFrame("bga-probe", () => {
        const serial = battleSerial();
        if (serial === lastSerial || sceneDumps >= MAX_SCENE_DUMPS) return;
        // 배틀 씬이 올라온 첫 프레임 (hitpoints.ts와 같은 기준: SceneObjectController가 생김)
        const soc = GameObject.method<Il2Cpp.Object>("Find", 1).invoke(Il2Cpp.string("SceneObjectController"));
        if (!soc || soc.isNull()) return;
        lastSerial = serial;
        sceneDumps++;
        const song = battleSong();
        const t0 = nowUs();
        if (!staticDone) {
            staticDone = true;
            log({ t: "bga-probe-unity", ...probeUnityStatic() });
            probeEgl();
            const video = song?.videoPath ?? null;
            setTimeout(() => {   // Java·MediaMetadataRetriever는 스크립트 스레드에서 (게임 스레드를 붙잡지 않게)
                try { probeAndroid(video); } catch (e) { log({ t: "bga-probe-android", error: `${e}` }); }
            }, 0);
        }
        let cameras: unknown, background: unknown;
        try { cameras = probeCameras(); } catch (e) { cameras = `error: ${e}`; }
        try { background = probeBackground(); } catch (e) { background = `error: ${e}`; }
        log({ t: "bga-probe-scene", serial, song: song?.name ?? null, custom: !!song, scene: song?.manifest.scene ?? null,
            hasVideo: !!song?.videoPath, cameras, background, ms: Math.round((nowUs() - t0) / 1000) });
    });
    log({ t: "bga-probe-ready" });
}
