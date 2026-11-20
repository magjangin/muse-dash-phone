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
//
// 파일 나눔(2026-11-13): files.ts(세트 파일 찾기·검사), build.ts(에셋 만들기), actions.ts(노트 액션 계약), 여기(캐시·훅).
import { guard, log } from "../log.js";
import { fileExists, makeDir } from "../native.js";
import { christmasReason } from "../christmas.js";
import { battleSerial } from "../customChart.js";
import { currentConfig } from "../config.js";
import { SKIN_ROOT, baseNameFromAssetName, setDir, setStamp } from "./files.js";
import { alive, buildAsset, classes, deadPart, materialOf, safeInvoke, syncShader } from "./build.js";
import { onFrame } from "../frame.js";
import { requiredAnimations } from "./actions.js";

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
const REVALIDATE_MS = 2000;

// ---- 캐시 ----
interface SetEntry { asset: Il2Cpp.Object | null; stamp: number; failed: boolean; checkedAt: number; serial: number; }
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
    if (characterSets.has(key)) {
        const cached = characterSets.get(key)!;
        // 씬 전환에 에셋 일부가 지워졌으면 다시 만든다(지워진 에셋을 씌우면 캐릭터가 안 보인다).
        const dead = cached ? deadPart(cached) : null;
        if (!dead) {
            if (cached && syncShader(cached, original)) log({ t: "skin-shader-resync", label: `character:${key}`, serial: battleSerial() });
            return cached;
        }
        log({ t: "skin-asset-dead", label: `character:${key}`, part: dead });
        ownAssets.delete(cached!.handle.toString());
        characterSets.delete(key);
    }
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
    const serial = battleSerial();
    let entry = noteSets.get(key);
    // 생존 확인은 판이 바뀌었을 때와 재검사 때만(Init은 노트 수만큼 불린다).
    if (entry?.asset && (entry.serial !== serial || now - entry.checkedAt >= REVALIDATE_MS)) {
        entry.serial = serial;
        const dead = deadPart(entry.asset);
        if (!dead && syncShader(entry.asset, original)) log({ t: "skin-shader-resync", label: `note:${key}`, serial });
        if (dead) {
            log({ t: "skin-asset-dead", label: `note:${key}`, part: dead });
            ownAssets.delete(entry.asset.handle.toString());
            noteSets.delete(key);
            entry = undefined;
        }
    }
    if (entry && now - entry.checkedAt < REVALIDATE_MS) return entry.asset;
    const dir = setDir("note", base);
    const stamp = setStamp(dir, base);
    if (entry && entry.stamp === stamp) { entry.checkedAt = now; entry.serial = serial; return entry.asset; }
    // 파일이 바뀌었다 → 다시 만든다(옛 에셋은 이미 씌운 노트가 쓰고 있을 수 있어 지우지 않는다).
    contractVerdicts.clear();
    warnedContracts.clear();
    let asset: Il2Cpp.Object | null = null;
    if (stamp !== 0) {
        asset = buildAsset(`note:${base}`, dir, base, scale, original);
        if (asset) { ownAssets.add(asset.handle.toString()); }
    }
    noteSets.set(key, { asset, stamp, failed: stamp !== 0 && asset === null, checkedAt: now, serial });
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

// 진단: 캐릭터에 씌운 뒤 3초 지나 렌더러 상태를 한 번 남긴다(판마다 캐릭터 2개).
const watched: { ska: Il2Cpp.Object; asset: Il2Cpp.Object; name: string; at: number; serial: number }[] = [];
function f32(p: NativePointer): number { return Math.round(p.readFloat() * 1000) / 1000; }
function characterState(w: typeof watched[number]): Record<string, unknown> {
    const st: Record<string, unknown> = { object: w.name, serial: w.serial };
    if (!alive(w.ska)) { st.ska = "dead"; return st; }
    st.assetSame = currentAsset(w.ska)?.handle.equals(w.asset.handle) ?? false;
    const ours = (w.asset.method<Il2Cpp.Object>("GetSkeletonData", 1).invoke(true) as Il2Cpp.Object).handle;
    const skel = w.ska.handle.add(0xC0).readPointer();
    st.dataSame = !skel.isNull() && skel.add(0x10).readPointer().equals(ours);
    st.valid = w.ska.handle.add(0xB8).readU8();
    if (!skel.isNull()) {
        st.rgba = [f32(skel.add(0x60)), f32(skel.add(0x64)), f32(skel.add(0x68)), f32(skel.add(0x6C))];
        st.scale = [f32(skel.add(0x74)), f32(skel.add(0x78))];
        st.xy = [f32(skel.add(0x7C)), f32(skel.add(0x80))];
    }
    const go = w.ska.method<Il2Cpp.Object>("get_gameObject").invoke();
    st.active = go.method<boolean>("get_activeInHierarchy").invoke();
    st.enabledSka = w.ska.method<boolean>("get_enabled").invoke();
    const mr = new Il2Cpp.Object(w.ska.handle.add(0xA8).readPointer());
    if (mr.handle.isNull() || !alive(mr)) { st.renderer = "none"; return st; }
    st.rendererEnabled = mr.method<boolean>("get_enabled").invoke();
    const mats = mr.method<Il2Cpp.Array<Il2Cpp.Object>>("get_sharedMaterials").invoke();
    st.materials = [] as string[];
    for (let i = 0; i < mats.length; i++) {
        const m = mats.get(i);
        if (!alive(m)) { (st.materials as string[]).push("dead"); continue; }
        const tex = m.method<Il2Cpp.Object>("get_mainTexture").invoke();
        (st.materials as string[]).push(`${m.method<Il2Cpp.String>("get_name").invoke()?.content}|${m.method<Il2Cpp.Object>("get_shader").invoke().method<Il2Cpp.String>("get_name").invoke()?.content}|tex:${alive(tex) ? tex.method<Il2Cpp.String>("get_name").invoke()?.content : "dead"}|q${m.method<number>("get_renderQueue").invoke()}`);
    }
    const b = mr.method<Il2Cpp.ValueType>("get_bounds").invoke();
    const ext = b.field<Il2Cpp.ValueType>("m_Extents").value;
    const ctr = b.field<Il2Cpp.ValueType>("m_Center").value;
    const v = (x: Il2Cpp.ValueType) => ["x", "y", "z"].map(k => Math.round(x.field<number>(k).value * 1000) / 1000);
    st.extents = v(ext);
    st.center = v(ctr);
    st.sortingOrder = mr.method<number>("get_sortingOrder").invoke();
    st.layer = go.method<number>("get_layer").invoke();
    return st;
}
let checkInstalled = false;
function watchCharacter(ska: Il2Cpp.Object, asset: Il2Cpp.Object, name: string): void {
    watched.push({ ska, asset, name, at: Date.now(), serial: battleSerial() });
    if (checkInstalled) return;
    checkInstalled = true;
    onFrame("spine-skin-check", () => {
        if (watched.length === 0) return;
        const now = Date.now();
        for (let i = watched.length - 1; i >= 0; i--) {
            if (now - watched[i].at < 3000) continue;
            const w = watched.splice(i, 1)[0];
            try { log({ t: "skin-character-state", ...characterState(w) }); }
            catch (e) { log({ t: "skin-character-state-error", object: w.name, error: `${e}` }); }
        }
    });
}

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
    watchCharacter(ska, asset, name);
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
