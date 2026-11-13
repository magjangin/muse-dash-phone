// 노트가 부르는 애니메이션 이름 (액션 계약). 새 스켈레톤에 이 이름이 다 있어야 노트 스킨을 씌운다(spineSkin.ts에서 분리).
import { ARRAY_DATA, ARRAY_LENGTH } from "../il2cpp.js";

// 필드 오프셋 (dump.cs)
const SAC_ACTION_DATA = 0x78, SAC_FEVER_ACTION_DATA = 0x80;   // SpineActionController.SkeletActionData[] (struct 배열)
const ACTION_DATA_SIZE = 0x28, ACTION_IDX = 0x18;              // SkeletActionData.actionIdx string[]

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

export function requiredAnimations(sac: Il2Cpp.Object): string[] {
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
