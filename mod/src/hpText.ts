// 체력바 글자 "250/250" → "made in 화영왕" (PC Patches/UI/Custom/HpMod 이식). 커스텀 곡 배틀에서만, 설정 없이 항상 켠다.
// 이 빌드에서 체력 글자를 쓰는 곳은 ChangeHealthValue.OnHpRateChange 0x1BA4EC0 하나뿐이다
// (PeroString에 "현재/GetHpMax"를 이어 붙여 PeroStringUtils.SetPeroText로 text에 넣음, logs/ChangeHealthValue.asm).
// OnHpDeduct·OnHpAdd·OnFail은 슬라이더 트윈만 돌리고 글자는 안 건드린다 → PC처럼 0.1초마다 다시 덮는 검사가 필요 없다.
// 그 직후(onLeave)에 덮고, 첫 표시를 위해 OnGameStart 0x1BA4B74 뒤에도 덮는다.
import { log } from "./log.js";
import { battleSerial, battleSong } from "./customChart.js";
import { gameClass, makeColor, makeVector2, unityClass } from "./il2cpp.js";

const LABEL = "made in 화영왕";
const TEXT_FIELD = "text";   // ChangeHealthValue.text (UnityEngine.UI.Text) +0x18

let styledSerial = -1;
const styled = new Set<string>();   // 이번 배틀에서 스타일을 입힌 Text 핸들

function addOrGet(go: Il2Cpp.Object, klass: Il2Cpp.Class): Il2Cpp.Object | null {
    const type = klass.type.object;
    const found = go.method<Il2Cpp.Object>("GetComponent", 1).invoke(type);
    if (found && !found.isNull()) return found;
    const added = go.method<Il2Cpp.Object>("AddComponent", 1).invoke(type);
    return added && !added.isNull() ? added : null;
}

// PC HywTextStyler.ApplyMadeByHywStyle와 같은 값.
function style(text: Il2Cpp.Object): void {
    const before = {
        text: text.method<Il2Cpp.String>("get_text").invoke()?.content ?? null,
        fontSize: text.method<number>("get_fontSize").invoke()
    };
    text.method("set_fontSize").invoke(18);
    text.method("set_color").invoke(makeColor(1, 1, 1, 1));
    text.method("set_fontStyle").invoke(1);   // FontStyle.Bold
    text.method("set_alignment").invoke(4);   // TextAnchor.MiddleCenter
    const go = text.method<Il2Cpp.Object>("get_gameObject").invoke();
    const shadow = addOrGet(go, unityClass("UnityEngine.UI", "UnityEngine.UI.Shadow"));
    if (shadow) {
        shadow.method("set_effectColor").invoke(makeColor(0, 0, 0, 0.6));
        shadow.method("set_effectDistance").invoke(makeVector2(1, 1));
    }
    const outline = addOrGet(go, unityClass("UnityEngine.UI", "UnityEngine.UI.Outline"));
    if (outline) {
        outline.method("set_effectColor").invoke(makeColor(0.1, 0.1, 0.1, 1));
        outline.method("set_effectDistance").invoke(makeVector2(0.5, 0.5));
    }
    log({ t: "hp-text-styled", before, shadow: shadow !== null, outline: outline !== null });
}

function apply(self: NativePointer, hook: string): void {
    if (battleSong() === null) return;
    const text = new Il2Cpp.Object(self).field<Il2Cpp.Object>(TEXT_FIELD).value;
    if (!text || text.isNull()) return;
    if (styledSerial !== battleSerial()) { styledSerial = battleSerial(); styled.clear(); }
    const key = text.handle.toString();
    if (!styled.has(key)) {
        styled.add(key);
        try { style(text); } catch (e) { log({ t: "hp-text-style-error", hook, error: `${e}` }); }
    }
    text.method("set_text").invoke(Il2Cpp.string(LABEL));
}

export function installHpText(): void {
    const klass = gameClass("ChangeHealthValue");
    for (const name of ["OnGameStart", "OnHpRateChange"]) {
        const method = klass.method(name, 3);
        Interceptor.attach(method.virtualAddress, {
            onEnter(args) { this.self = args[0]; },
            onLeave() {
                try { apply(this.self as NativePointer, name); }
                catch (e) { log({ t: "hp-text-error", hook: name, error: `${e}` }); }
            }
        });
    }
    log({ t: "hp-text-ready" });
}
