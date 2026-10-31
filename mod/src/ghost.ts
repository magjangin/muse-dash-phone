// 고스트 노트 보이기 (PC 모드 Patches/Battle/Mechanics/GhostNoteAlphaHold.cs 이식).
// 고스트(uid xx=17, type 4)가 판정선 앞에서 투명해지는 건 Spine 비행 애니메이션(in_nor_44)의 컬러 타임라인 알파 때문이다.
// "in" 재생 직후 그 애니메이션의 ColorTimeline/TwoColorTimeline 알파 키만 1로 덮는다(이동·스케일은 그대로).
// SkeletonData는 프로세스 내내 공유되므로 원래 알파를 기억해 두고, 옵션이 꺼진 곡(순정 곡 포함)에서는 되돌린다.
// 켜는 곳 (PC GhostNoteVisibility와 같은 규칙): 커스텀 곡은 info.txt '커스텀 곡 고스트 보이기'가 있으면 그 값,
// 없으면 전역 config.txt '고스트노트보이기'. 순정 곡은 전역 값을 따른다 (비서 앱 토글이 여기에 저장된다).
import { log } from "./log.js";
import { readIl2CppString } from "./native.js";
import { battleSerial, battleSong } from "./customChart.js";
import { currentConfig } from "./config.js";

// SpineActionController.m_MusicData(struct) 0xF0 + MusicData.noteData 0x50 → uid +0x10, type +0x38
const MD_NOTE_UID = 0xF0 + 0x50 + 0x10;
const MD_NOTE_TYPE = 0xF0 + 0x50 + 0x38;
const GHOST_TYPE = 4;
const ENTRIES = { ColorTimeline: 5, TwoColorTimeline: 8 } as Record<string, number>;   // time, r, g, b, a(, r2, g2, b2)
const ALPHA_OFFSET = 4;
const FLOAT_ARRAY_DATA = 0x20;

const originalAlphas = new Map<string, number[]>();   // 스켈레톤|애니메이션 → 덮기 전 알파
const opaqueState = new Map<string, boolean>();
let stateSerial = -1;

// PC ResetCache와 같은 역할: 판(배틀)마다 '이미 덮었다' 기록을 비운다. 씬을 다시 불러 SkeletonData가 같은 주소에
// 새로 올라오면 알파가 원본으로 돌아가 있는데, 기록만 보고 건너뛰어 고스트가 다시 투명해지던 문제를 막는다.
// 원래 알파(originalAlphas)는 끌 때 되돌리기 위해 남겨 둔다.
function resetIfNewBattle(): void {
    const s = battleSerial();
    if (s === stateSerial) return;
    stateSerial = s;
    opaqueState.clear();
}

function shouldShowGhosts(): boolean {
    const own = battleSong()?.manifest.showGhostNotes;
    if (own !== null && own !== undefined) return own;
    return currentConfig.showGhostNotes;
}

function isGhost(self: NativePointer): boolean {
    if (self.add(MD_NOTE_TYPE).readU32() === GHOST_TYPE) return true;
    const uid = readIl2CppString(self.add(MD_NOTE_UID).readPointer());
    return !!uid && /^\d{6}/.test(uid) && uid.substr(2, 2) === "17";
}

function apply(controller: Il2Cpp.Object, opaque: boolean): void {
    const skeleton = controller.method<Il2Cpp.Object>("get_skeletonAnimation").invoke()?.method<Il2Cpp.Object>("get_Skeleton").invoke();   // SkeletonRenderer.Skeleton (소문자 get_skeleton 없음)
    const data = skeleton?.method<Il2Cpp.Object>("get_Data").invoke();
    if (!data || data.isNull()) return;
    const animName = controller.method<Il2Cpp.String>("get_currentAnimationName").invoke()?.content;
    if (!animName) return;
    const key = `${data.handle}|${animName}`;
    if (opaqueState.get(key) === opaque) return;
    if (!opaque && !originalAlphas.has(key)) { opaqueState.set(key, false); return; }

    const anim = data.method<Il2Cpp.Object>("FindAnimation").invoke(Il2Cpp.string(animName));
    if (!anim || anim.isNull()) return;
    const timelines = anim.field<Il2Cpp.Object>("timelines").value;
    const items = timelines.field<Il2Cpp.Array<Il2Cpp.Object>>("Items").value;
    const count = Math.min(timelines.field<number>("Count").value, items.length);
    const saved = originalAlphas.get(key);
    const capture: number[] = [];
    let cursor = 0, keys = 0;
    for (let i = 0; i < count; i++) {
        const tl = items.get(i);
        if (!tl || tl.isNull()) continue;
        const entries = ENTRIES[tl.class.name];
        if (!entries) continue;
        const frames = tl.field<Il2Cpp.Array<number>>("frames").value;
        const base = frames.handle.add(FLOAT_ARRAY_DATA);
        for (let f = ALPHA_OFFSET; f < frames.length; f += entries) {
            const p = base.add(f * 4);
            if (saved === undefined) capture.push(p.readFloat());
            p.writeFloat(opaque ? 1 : (saved ? saved[cursor] : p.readFloat()));
            cursor++;
            keys++;
        }
    }
    if (saved === undefined) originalAlphas.set(key, capture);
    opaqueState.set(key, opaque);
    log({ t: "ghost-alpha", anim: animName, opaque, keys });
}

export function installGhost(): void {
    const Spine = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("SpineActionController");
    Interceptor.attach(Spine.method("PlayByKey", 2).virtualAddress, {
        onEnter(args) { (this as any).self = args[0]; (this as any).key = args[1]; },
        onLeave() {
            const keyPtr: NativePointer = (this as any).key;
            if (keyPtr.isNull() || readIl2CppString(keyPtr) !== "in") return;
            const self: NativePointer = (this as any).self;
            if (!isGhost(self)) return;
            try {
                resetIfNewBattle();
                apply(new Il2Cpp.Object(self), shouldShowGhosts());
            } catch (e) {
                log({ t: "ghost-error", error: `${e}` });
            }
        }
    });
    log({ t: "ghost-ready" });
}
