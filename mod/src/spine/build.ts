// Spine 스킨 에셋 만들기 (spineSkin.ts에서 분리, 2026-11-13). 게임에 든 spine-unity를 그대로 부른다.
// PNG → Texture2D(이름 = 아틀라스 첫 페이지 줄) → SpineAtlasAsset.CreateRuntimeInstance → json TextAsset
//   → SkeletonDataAsset.CreateRuntimeInstance(scale). PC CustomSkinInjector.BuildAsset.
import { log } from "../log.js";
import { byteArrayFromFile, gameClass, isNull, requireClass, unityClass } from "../il2cpp.js";
import { atlasTextureName, checkSetFiles, readTextFile } from "./files.js";

const HIDE_DONT_UNLOAD = 32;   // HideFlags.DontUnloadUnusedAsset: 씬 전환의 UnloadUnusedAssets에 안 지워지게

let K: ReturnType<typeof loadClasses> | null = null;
function loadClasses() {
    const core = (n: string) => unityClass("UnityEngine.CoreModule", n);
    const sda = requireClass("Spine.Unity.SkeletonDataAsset");
    const atlas = requireClass("Spine.Unity.SpineAtlasAsset");
    return {
        texture2D: core("UnityEngine.Texture2D"),
        textAsset: core("UnityEngine.TextAsset"),
        shader: core("UnityEngine.Shader"),
        loadImage: unityClass("UnityEngine.ImageConversionModule", "UnityEngine.ImageConversion").method<boolean>("LoadImage", 3),
        atlasCreate: atlas.method("CreateRuntimeInstance", 4)
            .overload("UnityEngine.TextAsset", "UnityEngine.Texture2D[]", "UnityEngine.Shader", "System.Boolean"),
        // 원본 머티리얼을 본떠(셰이더·렌더 순서·키워드) 새 머티리얼을 만드는 오버로드
        atlasCreateFromMaterial: atlas.method("CreateRuntimeInstance", 4)
            .overload("UnityEngine.TextAsset", "UnityEngine.Texture2D[]", "UnityEngine.Material", "System.Boolean"),
        sdaCreate: sda.method("CreateRuntimeInstance", 4)
            .overload("UnityEngine.TextAsset", "Spine.Unity.AtlasAssetBase", "System.Boolean", "System.Single"),
        getSkeletonData: sda.method("GetSkeletonData", 1),
        skeletonAnimation: requireClass("Spine.Unity.SkeletonAnimation"),
        sac: gameClass("SpineActionController")
    };
}
export const classes = () => (K ??= loadClasses());

// ---- 예외를 받는 호출 (il2cpp_runtime_invoke) ----
// 주의(2026-11-13 실측): 이 경로로 bool·float 같은 값 인자를 넘기면 게임에 제대로 안 들어간다
// (Initialize(true)가 false로 동작해 교체가 안 됐고, CreateRuntimeInstance의 scale이 0이 되어 메시가 한 점으로 모였다).
// 그래서 참조 인자만 받는 호출(InitSkField)에만 쓴다. 값 인자가 있는 Spine 호출은 브리지로 직접 부르고, 대신 파일을 미리 검사한다.
let runtimeInvoke: NativeFunction<NativePointer, [NativePointer, NativePointer, NativePointer, NativePointer]> | null = null;
type Arg = Il2Cpp.Object | boolean | number | null;

export function safeInvoke(method: Il2Cpp.Method, instance: Il2Cpp.Object | null, args: Arg[], floatArgs: number[] = []): NativePointer {
    runtimeInvoke ??= new NativeFunction(Il2Cpp.module.getExportByName("il2cpp_runtime_invoke"), "pointer", ["pointer", "pointer", "pointer", "pointer"]);
    const params = Memory.alloc(Math.max(1, args.length) * 8);
    args.forEach((a, i) => {
        let p: NativePointer;
        if (a === null) p = NULL;
        else if (typeof a === "boolean") { p = Memory.alloc(4); p.writeU8(a ? 1 : 0); }
        else if (typeof a === "number") {
            // 값 형식 인자는 값의 주소를 넘긴다. float로 넘길 칸은 floatArgs에 번호로 적는다.
            p = Memory.alloc(8);
            if (floatArgs.includes(i)) p.writeFloat(a); else p.writeS32(a);
        } else p = a.handle;   // 참조 형식은 객체 포인터 그대로
        params.add(i * 8).writePointer(p);
    });
    const exc = Memory.alloc(8).writePointer(NULL);
    const ret = runtimeInvoke(method.handle, instance ? instance.handle : NULL, params, exc);
    const e = exc.readPointer();
    if (!e.isNull()) throw new Error(`${method.name} 예외: ${describeException(e)}`);
    return ret;
}

function describeException(p: NativePointer): string {
    try {
        const o = new Il2Cpp.Object(p);
        const msg = o.tryField<Il2Cpp.String>("_message")?.value?.content ?? "";
        return `${o.class.name}: ${msg}`;
    } catch (_) {
        return p.toString();
    }
}

function keep(o: Il2Cpp.Object): Il2Cpp.Object {
    o.ref(true);
    try { o.method("set_hideFlags").invoke(HIDE_DONT_UNLOAD); } catch (_) { /* hideFlags가 없는 객체 */ }
    return o;
}

/** 원본 스켈레톤의 첫 머티리얼 (atlasAssets[0].materials[0]). 새 아틀라스 머티리얼의 본으로 쓴다. */
export function materialOf(originalAsset: Il2Cpp.Object | null): Il2Cpp.Object | null {
    try {
        if (!originalAsset) return null;
        const atlases = originalAsset.field<Il2Cpp.Array<Il2Cpp.Object>>("atlasAssets").value;
        if (!atlases || atlases.isNull() || atlases.length === 0) return null;
        const mats = atlases.get(0).tryField<Il2Cpp.Array<Il2Cpp.Object>>("materials")?.value;
        if (!mats || mats.isNull() || mats.length === 0) return null;
        const m = mats.get(0);
        return m && !m.isNull() ? m : null;
    } catch (_) {
        return null;
    }
}

/** 원본 스켈레톤이 쓰는 셰이더 (안드로이드에서 Shader.Find가 null일 때 대신). */
function shaderOf(originalAsset: Il2Cpp.Object | null): Il2Cpp.Object | null {
    try {
        const m = materialOf(originalAsset);
        const shader = m ? m.method<Il2Cpp.Object>("get_shader").invoke() : null;
        return shader && !shader.isNull() ? shader : null;
    } catch (_) {
        return null;
    }
}

function findShader(originalAsset: Il2Cpp.Object | null): { shader: Il2Cpp.Object | null; source: string } {
    const find = (name: string) => {
        const s = classes().shader.method<Il2Cpp.Object>("Find", 1).invoke(Il2Cpp.string(name));
        return s && !s.isNull() ? s : null;
    };
    const spine = find("Spine/Skeleton");
    if (spine) return { shader: spine, source: "Spine/Skeleton" };
    const original = shaderOf(originalAsset);
    if (original) return { shader: original, source: "original" };
    return { shader: find("Sprites/Default"), source: "Sprites/Default" };
}

/** png·atlas·json 세 파일로 SkeletonDataAsset을 만든다. 실패하면 null(로그 남김). PC CustomSkinInjector.BuildAsset. */
export function buildAsset(label: string, dir: string, base: string, scale: number, originalAsset: Il2Cpp.Object | null): Il2Cpp.Object | null {
    const started = Date.now();
    const k = classes();
    try {
        const atlasText = readTextFile(`${dir}/${base}.atlas`);
        const jsonText = readTextFile(`${dir}/${base}.json`);
        // 아래 Spine 생성 호출은 브리지로 직접 부르므로(값 인자 때문, safeInvoke 주석 참고) 거기서 예외가 나면 게임이 죽는다.
        // 그래서 파일이 이상하면 여기서 미리 거른다: JSON 문법, Spine 3.8, 아틀라스 첫 페이지 = PNG.
        const problem = checkSetFiles(jsonText, atlasText);
        if (problem) {
            log({ t: "skin-bad-files", label, reason: problem });
            return null;
        }

        const array = byteArrayFromFile(`${dir}/${base}.png`);
        const tex = k.texture2D.alloc();
        try {
            // PC와 같은 RGBA32(4), 밉맵 없음. 오버로드가 안 맞으면 (w, h)로.
            tex.method(".ctor").overload("System.Int32", "System.Int32", "UnityEngine.TextureFormat", "System.Boolean").invoke(2, 2, 4 as any, false);
        } catch (_) {
            tex.method(".ctor").overload("System.Int32", "System.Int32").invoke(2, 2);
        }
        const texName = atlasTextureName(atlasText, base);
        tex.method("set_name").invoke(Il2Cpp.string(texName));
        if (!k.loadImage.invoke(tex, array, false)) {
            log({ t: "skin-bad-png", label });
            return null;
        }
        keep(tex);

        const textAsset = (text: string) => {
            const ta = k.textAsset.alloc();
            ta.method(".ctor").overload("System.String").invoke(Il2Cpp.string(text));
            return keep(ta);
        };
        const atlasTA = textAsset(atlasText);
        const jsonTA = textAsset(jsonText);
        const textures = Il2Cpp.array(k.texture2D, [tex]);
        // 원본 머티리얼이 있으면 그걸 본떠 같은 셰이더·설정을 쓴다(본체 린 = Spine/Skeleton Tint, 고스트 = Unlit/Ghost,
        // 5번 씬 노트 = s05_atlas_Material). 없을 때만 Shader.Find("Spine/Skeleton")로 새로 만든다.
        const template = materialOf(originalAsset);
        let source: string;
        let atlasPtr: NativePointer;
        let atlasObj: Il2Cpp.Object;
        if (template) {
            source = `material:${template.method<Il2Cpp.String>("get_name").invoke()?.content ?? "?"}/${template.method<Il2Cpp.Object>("get_shader").invoke().method<Il2Cpp.String>("get_name").invoke()?.content ?? "?"}`;
            atlasObj = k.atlasCreateFromMaterial.invoke(atlasTA, textures, template, true) as Il2Cpp.Object;
        } else {
            const found = findShader(originalAsset);
            source = found.source;
            atlasObj = k.atlasCreate.invoke(atlasTA, textures, found.shader!, true) as Il2Cpp.Object;
        }
        atlasPtr = atlasObj ? atlasObj.handle : NULL;
        if (isNull(atlasPtr)) { log({ t: "skin-atlas-fail", label }); return null; }
        const atlasAsset = keep(atlasObj);

        // scale은 float 값 인자라 브리지로 직접 부른다(safeInvoke로 넘기면 0이 들어가 메시가 한 점으로 모였다).
        const sdaObj = k.sdaCreate.invoke(jsonTA, atlasAsset, true, scale) as Il2Cpp.Object;
        if (!sdaObj || sdaObj.isNull()) { log({ t: "skin-data-fail", label }); return null; }
        const sda = keep(sdaObj);
        const data = sda.method<Il2Cpp.Object>("GetSkeletonData", 1).invoke(true) as Il2Cpp.Object;
        if (!data || data.isNull()) { log({ t: "skin-data-fail", label, reason: "GetSkeletonData null" }); return null; }
        const realScale = sda.field<number>("scale").value;

        log({ t: "skin-built", label, dir, scale, realScale, texture: texName, shader: source, ms: Date.now() - started });
        return sda;
    } catch (e) {
        log({ t: "skin-build-error", label, dir, error: `${e}` });
        return null;
    }
}
