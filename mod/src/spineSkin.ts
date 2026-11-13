// 커스텀 Spine 스킨: 캐릭터(모든 곡)와 노트(크리스마스 곡만).
// PC 모드 Spine/CustomSkinInjector.cs + Patch_Inject_BlackGirlBattle.cs + NoteSkinInjector.cs + NoteSkinRules.cs + SkinFolderRules.cs 이식
// (PC d24b79d·6ab925f·4104ff5·9348d84·083ab43·d663c22).
//
// 파일: <앱 files>/skin test/character/{세트}/{세트}.json·.atlas·.png (캐릭터 5종, 이름 고정)
//       <앱 files>/skin test/note/{원본 스켈레톤 이름}/... (예: 게임 에셋 0506_road_SkeletonData → note/0506_road)
//       옛 배치 skin test/{세트}/도 읽는다(새 위치가 이김). Spine 3.8 JSON 내보내기만 읽는다(.skel 바이너리는 안 됨).
//
// 언제: SpineActionController.Init(int, int) 직후(노트·캐릭터 모두 여기서 만들어짐). 캐릭터는 OnControllerStart 직후에도
//   다시 씌운다(재시작). 노트는 Init에서만: OnControllerStart에서 Initialize(true)를 부르면 재생 중 상태가 지워진다(PC 주석).
//
// 만들기: 게임에 든 spine-unity를 그대로 부른다. PNG → Texture2D(이름 = 아틀라스 첫 페이지 줄) → SpineAtlasAsset.CreateRuntimeInstance
//   → json TextAsset → SkeletonDataAsset.CreateRuntimeInstance(scale). 배율은 원본 × 2(스킨 파일 좌표가 원본의 절반인 관행,
//   캐릭터 0.01 고정 = 원본 0.005 × 2).
//
// Frida 주의: 브리지의 invoke는 게임 함수를 직접 부르므로, 거기서 IL2CPP 예외가 나면 Frida 프레임을 못 넘어가 게임이 abort된다
//   (AGENTS.md Dead End). il2cpp_runtime_invoke로 예외를 받으려 했지만 그 경로로는 bool·float 값 인자가 제대로 안 들어가서
//   (safeInvoke 주석) Spine 생성·Initialize는 직접 부르고, 대신 세트 파일을 JS에서 미리 검사한다(checkSetFiles).
//   캐시 키에 원본 머티리얼 이름을 넣는다: 같은 세트라도 본체와 고스트는 머티리얼이 달라 에셋을 따로 만든다.
import { MOD_DIR, guard, log } from "./log.js";
import { fileExists, makeDir, regularFileSize } from "./native.js";
import { christmasReason } from "./christmas.js";
import { battleSerial } from "./customChart.js";
import { currentConfig } from "./config.js";

export const SKIN_ROOT = `${MOD_DIR}/skin test`;

// GameObject 이름 → 캐릭터 세트 (PC InjectHelper.TargetToBaseName). 그림자는 대상에서 뺀다(PC와 같음).
const CHARACTER_TARGETS: Record<string, string> = {
    "black_girl_battle(Clone)": "char_3_black", "black_girl_battle_ghost(Clone)": "char_3_black",
    "sleepy_girl_battle(Clone)": "char_1_sleepy", "sleepy_girl_battle_ghost(Clone)": "char_1_sleepy",
    "rock_girl_battle(Clone)": "char_1_rock", "rock_girl_battle_ghost(Clone)": "char_1_rock",
    "rampage_girl_battle(Clone)": "char_1_rampage", "rampage_girl_battle_ghost(Clone)": "char_1_rampage",
    "violin_girl_battle(Clone)": "char_3_violin", "violin_girl_battle_ghost(Clone)": "char_3_violin"
};
const CHARACTER_SCALE = 0.01;
const HALF_IMPORT_FACTOR = 2;
const SKELETON_DATA_SUFFIX = "_SkeletonData";
const REVALIDATE_MS = 2000;
const HIDE_DONT_UNLOAD = 32;   // HideFlags.DontUnloadUnusedAsset: 씬 전환의 UnloadUnusedAssets에 안 지워지게

// 필드 오프셋 (dump.cs)
const SAC_ACTION_DATA = 0x78, SAC_FEVER_ACTION_DATA = 0x80;   // SpineActionController.SkeletActionData[] (struct 배열)
const ACTION_DATA_SIZE = 0x28, ACTION_IDX = 0x18;              // SkeletActionData.actionIdx string[]
const ARRAY_LENGTH = 0x18, ARRAY_DATA = 0x20;

type Kind = "character" | "note";

function findClass(name: string): Il2Cpp.Class {
    for (const a of Il2Cpp.domain.assemblies) {
        const k = a.image.tryClass(name);
        if (k) return k;
    }
    throw new Error(`클래스 없음: ${name}`);
}

let K: ReturnType<typeof loadClasses> | null = null;
function loadClasses() {
    const core = (n: string) => Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class(n);
    const sda = findClass("Spine.Unity.SkeletonDataAsset");
    const atlas = findClass("Spine.Unity.SpineAtlasAsset");
    return {
        texture2D: core("UnityEngine.Texture2D"),
        textAsset: core("UnityEngine.TextAsset"),
        shader: core("UnityEngine.Shader"),
        loadImage: Il2Cpp.domain.assembly("UnityEngine.ImageConversionModule").image.class("UnityEngine.ImageConversion").method<boolean>("LoadImage", 3),
        atlasCreate: atlas.method("CreateRuntimeInstance", 4)
            .overload("UnityEngine.TextAsset", "UnityEngine.Texture2D[]", "UnityEngine.Shader", "System.Boolean"),
        // 원본 머티리얼을 본떠(셰이더·렌더 순서·키워드) 새 머티리얼을 만드는 오버로드
        atlasCreateFromMaterial: atlas.method("CreateRuntimeInstance", 4)
            .overload("UnityEngine.TextAsset", "UnityEngine.Texture2D[]", "UnityEngine.Material", "System.Boolean"),
        sdaCreate: sda.method("CreateRuntimeInstance", 4)
            .overload("UnityEngine.TextAsset", "Spine.Unity.AtlasAssetBase", "System.Boolean", "System.Single"),
        getSkeletonData: sda.method("GetSkeletonData", 1),
        skeletonAnimation: findClass("Spine.Unity.SkeletonAnimation"),
        sac: Il2Cpp.domain.assembly("Assembly-CSharp").image.class("SpineActionController")
    };
}
const classes = () => (K ??= loadClasses());

// ---- 예외를 받는 호출 (il2cpp_runtime_invoke) ----
// 주의(2026-11-13 실측): 이 경로로 bool·float 같은 값 인자를 넘기면 게임에 제대로 안 들어간다
// (Initialize(true)가 false로 동작해 교체가 안 됐고, CreateRuntimeInstance의 scale이 0이 되어 메시가 한 점으로 모였다).
// 그래서 참조 인자만 받는 호출(InitSkField)에만 쓴다. 값 인자가 있는 Spine 호출은 브리지로 직접 부르고, 대신 파일을 미리 검사한다.
let runtimeInvoke: NativeFunction<NativePointer, [NativePointer, NativePointer, NativePointer, NativePointer]> | null = null;
type Arg = Il2Cpp.Object | boolean | number | null;

function safeInvoke(method: Il2Cpp.Method, instance: Il2Cpp.Object | null, args: Arg[], floatArgs: number[] = []): NativePointer {
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

const isNull = (p: NativePointer | null | undefined) => !p || p.isNull();

// ---- 파일 ----
function setDir(kind: Kind, base: string): string {
    const preferred = `${SKIN_ROOT}/${kind}/${base}`;
    if (fileExists(`${preferred}/${base}.json`)) return preferred;
    const legacy = `${SKIN_ROOT}/${base}`;
    return fileExists(`${legacy}/${base}.json`) ? legacy : preferred;
}

/** 아틀라스 첫 페이지 줄의 텍스처 이름(확장자 제외). SpineAtlasAsset은 페이지를 Texture2D.name으로 찾는다(PC NoteSkinRules). */
export function atlasTextureName(atlasText: string, fallback: string): string {
    for (const raw of atlasText.split(/\r?\n/)) {
        const line = raw.replace(/^﻿/, "").trim();
        if (!line) continue;
        if (line.includes(":")) return fallback;
        const name = line.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
        return name || fallback;
    }
    return fallback;
}

/** 원본 에셋 이름 → 세트 이름. 0506_road_SkeletonData → 0506_road. 경로로 쓰이므로 이상한 이름은 null. */
export function baseNameFromAssetName(assetName: string | null): string | null {
    if (!assetName) return null;
    let name = assetName.trim();
    if (name.toLowerCase().endsWith(SKELETON_DATA_SUFFIX.toLowerCase())) name = name.substring(0, name.length - SKELETON_DATA_SUFFIX.length);
    if (!name || name === "." || name === ".." || /[\\/:*?"<>|\0]/.test(name)) return null;
    return name;
}

/** 세트 파일 미리 검사. 문제가 없으면 null, 있으면 이유. */
function checkSetFiles(jsonText: string, atlasText: string): string | null {
    let json: any;
    try { json = JSON.parse(jsonText); } catch (e) { return `JSON 문법 오류(.skel 바이너리를 이름만 바꾼 파일?): ${`${e}`.substring(0, 80)}`; }
    const version = `${json?.skeleton?.spine ?? ""}`;
    if (!version.startsWith("3.8")) return `Spine 버전 ${version || "없음"} (게임은 3.8)`;
    if (!json.bones || !json.slots) return "bones/slots 없음";
    const firstLine = atlasText.split(/\r?\n/).map(l => l.replace(/^﻿/, "").trim()).find(l => l.length > 0) ?? "";
    if (!firstLine || firstLine.includes(":")) return "아틀라스 첫 줄이 페이지 이름이 아님";
    return null;
}

function setStamp(dir: string, base: string): number {
    let stamp = 17;
    for (const ext of ["png", "atlas", "json"]) {
        const size = regularFileSize(`${dir}/${base}.${ext}`);
        if (size < 0) return 0;
        stamp = (stamp * 31 + size) % 2147483647;
    }
    return stamp === 0 ? 1 : stamp;
}

function readTextFile(path: string): string {
    return File.readAllText(path).replace(/^﻿/, "");
}

function keep(o: Il2Cpp.Object): Il2Cpp.Object {
    o.ref(true);
    try { o.method("set_hideFlags").invoke(HIDE_DONT_UNLOAD); } catch (_) { /* hideFlags가 없는 객체 */ }
    return o;
}

/** 원본 스켈레톤의 첫 머티리얼 (atlasAssets[0].materials[0]). 새 아틀라스 머티리얼의 본으로 쓴다. */
function materialOf(originalAsset: Il2Cpp.Object | null): Il2Cpp.Object | null {
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
function buildAsset(label: string, dir: string, base: string, scale: number, originalAsset: Il2Cpp.Object | null): Il2Cpp.Object | null {
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

        const bytes = new Uint8Array(File.readAllBytes(`${dir}/${base}.png`));
        const array = Il2Cpp.array<number>(Il2Cpp.corlib.class("System.Byte"), bytes.length);
        array.handle.add(ARRAY_DATA).writeByteArray(bytes.buffer as ArrayBuffer);
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

// ---- 노트가 부르는 애니메이션 (액션 계약) ----
function readStringArray(p: NativePointer): string[] {
    if (p.isNull()) return [];
    const out: string[] = [];
    const n = p.add(ARRAY_LENGTH).readU32();
    for (let i = 0; i < n; i++) {
        const s = p.add(ARRAY_DATA + i * 8).readPointer();
        if (s.isNull()) continue;
        const text = s.add(0x14).readUtf16String(s.add(0x10).readS32());
        if (text) out.push(text);
    }
    return out;
}

function requiredAnimations(sac: Il2Cpp.Object): string[] {
    const names: string[] = [];
    for (const off of [SAC_ACTION_DATA, SAC_FEVER_ACTION_DATA]) {
        const arr = sac.handle.add(off).readPointer();
        if (arr.isNull()) continue;
        const n = arr.add(ARRAY_LENGTH).readU32();
        for (let i = 0; i < n; i++) {
            names.push(...readStringArray(arr.add(ARRAY_DATA + i * ACTION_DATA_SIZE + ACTION_IDX).readPointer()));
        }
    }
    return [...new Set(names.filter(n => n.length > 0))];
}

// ---- 캐시 ----
interface SetEntry { asset: Il2Cpp.Object | null; stamp: number; failed: boolean; checkedAt: number; }
const characterSets = new Map<string, Il2Cpp.Object | null>();
const noteSets = new Map<string, SetEntry>();
const ownAssets = new Set<string>();
const contractVerdicts = new Map<string, string[]>();
const warnedContracts = new Set<string>();
let noteInjected = 0;

/** 원본 머티리얼 이름 (캐시 키). 같은 스켈레톤이라도 본체와 고스트는 머티리얼이 달라(고스트는 Unlit/Ghost) 에셋을 따로 만든다. */
function materialKey(original: Il2Cpp.Object | null): string {
    try { return materialOf(original)?.method<Il2Cpp.String>("get_name").invoke()?.content ?? "-"; } catch (_) { return "-"; }
}

function characterAsset(base: string, original: Il2Cpp.Object | null): Il2Cpp.Object | null {
    // 캐릭터 스킨은 게임을 다시 켜야 다시 읽는다(PC와 같음). 실패도 기억해 판마다 다시 만들지 않는다.
    // 키에 원본 머티리얼을 넣는다: 처음엔 세트 이름만 키로 써서 먼저 Init된 고스트의 머티리얼(Unlit/Ghost)로 만든 에셋을
    // 본체 린에도 씌웠고, 본체가 화면에서 사라졌다(2026-11-13 실측).
    const key = `${base}|${materialKey(original)}`;
    if (characterSets.has(key)) return characterSets.get(key)!;
    const dir = setDir("character", base);
    const asset = setStamp(dir, base) === 0 ? null : buildAsset(`character:${key}`, dir, base, CHARACTER_SCALE, original);
    if (asset) { ownAssets.add(asset.handle.toString()); }
    else log({ t: "skin-character-missing", base, dir });
    characterSets.set(key, asset);
    return asset;
}

function noteAsset(base: string, scale: number, original: Il2Cpp.Object): Il2Cpp.Object | null {
    const key = `${base}|${scale}|${materialKey(original)}`;
    const now = Date.now();
    const entry = noteSets.get(key);
    if (entry && now - entry.checkedAt < REVALIDATE_MS) return entry.asset;
    const dir = setDir("note", base);
    const stamp = setStamp(dir, base);
    if (entry && entry.stamp === stamp) { entry.checkedAt = now; return entry.asset; }
    // 파일이 바뀌었다 → 다시 만든다(옛 에셋은 이미 씌운 노트가 쓰고 있을 수 있어 지우지 않는다).
    contractVerdicts.clear();
    warnedContracts.clear();
    let asset: Il2Cpp.Object | null = null;
    if (stamp !== 0) {
        asset = buildAsset(`note:${base}`, dir, base, scale, original);
        if (asset) { ownAssets.add(asset.handle.toString()); }
    }
    noteSets.set(key, { asset, stamp, failed: stamp !== 0 && asset === null, checkedAt: now });
    return asset;
}

// 노트 스킨을 씌울 곡인지(크리스마스 곡). Init은 노트 수만큼 불리므로 같은 판에서는 판정을 재사용한다.
let gateSerial = -1;
let gate: string | null = null;
function christmasGate(): string | null {
    const serial = battleSerial();
    if (serial !== gateSerial) {
        gateSerial = serial;
        gate = christmasReason();
        noteInjected = 0;
        log({ t: "note-skin-gate", serial, christmas: gate });
    }
    return gate;
}

function objectName(sac: Il2Cpp.Object): string | null {
    return sac.method<Il2Cpp.Object>("get_gameObject").invoke().method<Il2Cpp.String>("get_name").invoke()?.content ?? null;
}

function skeletonAnimationOf(sac: Il2Cpp.Object): Il2Cpp.Object | null {
    const ska = sac.method<Il2Cpp.Object>("get_skeletonAnimation").invoke();
    return ska && !ska.isNull() ? ska : null;
}

function currentAsset(ska: Il2Cpp.Object): Il2Cpp.Object | null {
    const a = ska.field<Il2Cpp.Object>("skeletonDataAsset").value;
    return a && !a.isNull() ? a : null;
}

let swapLogged = 0;
function skeletonDataOf(ska: Il2Cpp.Object): NativePointer {
    const skel = ska.handle.add(0xC0).readPointer();   // SkeletonRenderer.skeleton
    return skel.isNull() ? NULL : skel.add(0x10).readPointer();   // Skeleton.data
}
function swapAsset(sac: Il2Cpp.Object, ska: Il2Cpp.Object, asset: Il2Cpp.Object, initSkField: boolean): void {
    ska.field<Il2Cpp.Object>("skeletonDataAsset").value = asset;
    // il2cpp_runtime_invoke로 부르면 overwrite가 false로 들어가 "이미 초기화됨"으로 바로 빠져나갔다(2026-11-13 실측: 교체 전후 Skeleton.data 같음).
    // 에셋은 위에서 이미 만들고 검사했으므로(GetSkeletonData 성공) 여기서는 브리지로 직접 부른다.
    ska.method("Initialize", 1).invoke(true);
    if (initSkField) safeInvoke(classes().sac.method("InitSkField", 1), sac, [ska]);
    // 교체가 실제로 먹었는지: 스켈레톤이 우리 데이터로 다시 만들어졌어야 한다. 처음 한 번과 실패만 남긴다.
    const ours = (asset.method<Il2Cpp.Object>("GetSkeletonData", 1).invoke(true) as Il2Cpp.Object).handle;
    const ok = skeletonDataOf(ska).equals(ours);
    if (!ok || swapLogged === 0) {
        if (swapLogged++ < 5) log({ t: ok ? "skin-swap-ok" : "skin-swap-failed", valid: ska.handle.add(0xB8).readU8() });
    }
}

const seenOtherCharacters = new Set<string>();

function tryCharacter(sac: Il2Cpp.Object, name: string, where: string): boolean {
    const base = CHARACTER_TARGETS[name];
    if (!base) {
        // 스킨 대상이 아닌 캐릭터는 이름만 한 번 남긴다(지금 고른 캐릭터가 대상인지 로그로 알 수 있게).
        if (name.includes("_battle") && !seenOtherCharacters.has(name)) {
            seenOtherCharacters.add(name);
            log({ t: "skin-character-other", object: name });
        }
        return false;
    }
    const ska = skeletonAnimationOf(sac);
    if (!ska) return true;
    const original = currentAsset(ska);
    if (original && ownAssets.has(original.handle.toString()) && where !== "start") return true;
    const asset = characterAsset(base, original);
    if (!asset) return true;
    swapAsset(sac, ska, asset, false);
    log({ t: "skin-character", object: name, base, where });
    return true;
}

function tryNote(sac: Il2Cpp.Object, name: string): void {
    if (!christmasGate()) return;
    const ska = skeletonAnimationOf(sac);
    if (!ska) return;
    const original = currentAsset(ska);
    if (!original || ownAssets.has(original.handle.toString())) return;
    const base = baseNameFromAssetName(original.method<Il2Cpp.String>("get_name").invoke()?.content ?? null);
    if (!base) return;
    const scale = original.field<number>("scale").value * HALF_IMPORT_FACTOR;
    const asset = noteAsset(base, scale, original);
    if (!asset) return;

    const required = requiredAnimations(sac);
    const contractKey = `${asset.handle}|${required.join("\u0001")}`;
    let missing = contractVerdicts.get(contractKey);
    if (!missing) {
        const data = asset.method<Il2Cpp.Object>("GetSkeletonData", 1).invoke(true) as Il2Cpp.Object;
        missing = required.filter(n => {
            const anim = data.method<Il2Cpp.Object>("FindAnimation", 1).invoke(Il2Cpp.string(n));
            return !anim || anim.isNull();
        });
        contractVerdicts.set(contractKey, missing);
    }
    if (missing.length > 0) {
        // 멈추거나 안 보이는 노트보다 원본 노트가 낫다(PC와 같음).
        if (!warnedContracts.has(contractKey)) {
            warnedContracts.add(contractKey);
            log({ t: "note-skin-contract", base, prefab: name.replace(/\(Clone\).*$/, ""), missing });
        }
        return;
    }
    swapAsset(sac, ska, asset, true);
    noteInjected++;
    if (noteInjected === 1 || noteInjected % 200 === 0) log({ t: "note-skin", count: noteInjected, base, prefab: name.replace(/\(Clone\).*$/, "") });
}

/** 시작 시 빈 폴더를 만들어 둔다(PC EnsureSetFolders). */
function ensureFolders(): void {
    for (const dir of [SKIN_ROOT, `${SKIN_ROOT}/character`, `${SKIN_ROOT}/note`]) {
        if (!fileExists(dir)) makeDir(dir);   // 실패해도 동작엔 지장 없음(세트가 없으면 원본 그대로)
    }
}

export function installSpineSkin(): void {
    guard("skin-folders", ensureFolders);
    const sac = classes().sac;

    Interceptor.attach(sac.method("Init", 2).virtualAddress, {
        onEnter(args) { (this as any).self = args[0]; },
        onLeave() {
            if (!currentConfig.enableSpineSkin) return;
            guard("spine-skin-init", () => {
                const self = new Il2Cpp.Object((this as any).self);
                const name = objectName(self);
                if (!name) return;
                if (tryCharacter(self, name, "init")) return;
                tryNote(self, name);
            });
        }
    });
    // 재시작·재진입 때 캐릭터에 다시 씌운다(PC Patch_Inject_OnControllerStart). 노트는 여기서 안 한다.
    Interceptor.attach(sac.method("OnControllerStart", 0).virtualAddress, {
        onEnter(args) { (this as any).self = args[0]; },
        onLeave() {
            if (!currentConfig.enableSpineSkin) return;
            guard("spine-skin-start", () => {
                const self = new Il2Cpp.Object((this as any).self);
                const name = objectName(self);
                if (name && CHARACTER_TARGETS[name]) {
                    const ska = skeletonAnimationOf(self);
                    const cur = ska ? currentAsset(ska) : null;
                    if (cur && ownAssets.has(cur.handle.toString())) return;   // 이미 씌움
                    tryCharacter(self, name, "start");
                }
            });
        }
    });
    log({ t: "spine-skin-ready", root: SKIN_ROOT });
}
