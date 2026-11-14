// 체력바 글자 "250/250" → "made in 화영왕" (PC Patches/UI/Custom/HpMod 이식). 커스텀 곡 배틀에서만, 설정 없이 항상 켠다.
// 이 빌드에서 체력 글자를 쓰는 곳은 ChangeHealthValue.OnHpRateChange 0x1BA4EC0 하나뿐이다
// (PeroString에 "현재/GetHpMax"를 이어 붙여 PeroStringUtils.SetPeroText로 text에 넣음, logs/ChangeHealthValue.asm).
// OnHpDeduct·OnHpAdd·OnFail은 슬라이더 트윈만 돌리고 글자는 안 건드린다 → PC처럼 0.1초마다 다시 덮는 검사가 필요 없다.
// 그 직후(onLeave)에 덮고, 첫 표시를 위해 OnGameStart 0x1BA4B74 뒤에도 덮는다.
//
// 비용 (2026-11-14 실측, 유얼 리얼리티): 배틀에 ChangeHealthValue가 2개 있어 체력이 바뀔 때마다 훅이 두 번 돈다.
// 처음 판(브리지로 필드·메서드를 매번 찾고 문자열을 매번 만듦)은 한 번에 136~431 µs, 스타일 입히는 첫 호출 2.7 ms.
// 지금은 대상(ChangeHealthValue)마다 배틀당 한 번만 브리지로 풀어 두고, 그 뒤엔 필드를 직접 읽어 set_text를 NativeFunction으로 부른다.
// 바꾼 뒤 같은 곡에서 30~221 µs(첫 호출 3.9 ms). 남은 몫은 대부분 Unity Text.set_text 자체(메시 다시 그리기 표시)라 더 줄일 곳이 없다.
// 둘 중 하나는 text가 null이라 필드만 읽고 끝난다. 어느 쪽이든 프레임(16.7 ms)에 비하면 작다 — 원래도 병목은 아니었다.
// 라벨 문자열은 한 번 만들어 고정(pinnedString)한다. 체력바 UI는 배틀마다 새로 만들어져서(공식 곡을 이어서 해도 원래 모양) 되돌리기는 필요 없다.
import { log } from "./log.js";
import { battleSerial, battleSong } from "./customChart.js";
import { gameClass, makeColor, makeVector2, unityClass } from "./il2cpp.js";
import { nowUs, pinnedString } from "./native.js";
import { perfMark } from "./perf.js";

const LABEL = "made in 화영왕";
const TEXT_FIELD = "text";   // ChangeHealthValue.text (UnityEngine.UI.Text) +0x18
const COST_LOGS = 4;         // 배틀마다 처음 몇 번과
const COST_EVERY = 20;       // 그 뒤 몇 번째마다 비용을 남긴다

type SetText = NativeFunction<void, [NativePointer, NativePointer, NativePointer]>;
interface Target { text: NativePointer; setText: SetText | null; method: NativePointer; }

let textOffset = -1;
let label: NativePointer | null = null;
let serial = -1;
let costCalls = 0;
const targets = new Map<string, Target>();      // 이번 배틀의 ChangeHealthValue 핸들 → 풀어 둔 Text·set_text
const setTextFns = new Map<string, SetText>();  // set_text MethodInfo* → 호출 함수 (클래스가 같으면 같이 쓴다)

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

/** 대상을 이번 배틀에 처음 볼 때: Text 스타일을 입히고 실제 클래스의 set_text를 풀어 둔다(Text 하위 클래스가 덮었을 수 있음). */
function resolve(self: NativePointer, hook: string): Target {
    const text = self.add(textOffset).readPointer();
    const target: Target = { text, setText: null, method: NULL };
    if (text.isNull()) {
        log({ t: "hp-text-target", hook, self: self.toString(), text: null });
        return target;
    }
    const obj = new Il2Cpp.Object(text);
    try { style(obj); } catch (e) { log({ t: "hp-text-style-error", hook, error: `${e}` }); }
    const method = obj.method("set_text", 1);
    const key = method.handle.toString();
    let fn = setTextFns.get(key);
    if (fn === undefined) {
        fn = new NativeFunction(method.virtualAddress, "void", ["pointer", "pointer", "pointer"]) as SetText;
        setTextFns.set(key, fn);
    }
    target.setText = fn;
    target.method = method.handle;
    log({ t: "hp-text-target", hook, self: self.toString(), text: text.toString(), cls: obj.class.name, setText: method.virtualAddress.sub(Il2Cpp.module.base).toString() });
    return target;
}

function apply(self: NativePointer, hook: string): void {
    if (serial !== battleSerial()) { serial = battleSerial(); targets.clear(); costCalls = 0; }
    const key = self.toString();
    let target = targets.get(key);
    // 같은 ChangeHealthValue의 text가 바뀌었으면(보통은 없음) 다시 푼다.
    if (target === undefined || !self.add(textOffset).readPointer().equals(target.text)) {
        target = resolve(self, hook);
        targets.set(key, target);
    }
    if (target.setText === null) return;
    target.setText(target.text, label!, target.method);
}

export function installHpText(): void {
    const klass = gameClass("ChangeHealthValue");
    textOffset = klass.field(TEXT_FIELD).offset;
    label = pinnedString(LABEL);
    for (const name of ["OnGameStart", "OnHpRateChange"]) {
        const method = klass.method(name, 3);
        Interceptor.attach(method.virtualAddress, {
            onEnter(args) { this.self = args[0]; },
            onLeave() {
                if (battleSong() === null) return;
                const t0 = nowUs();
                try { apply(this.self as NativePointer, name); }
                catch (e) { log({ t: "hp-text-error", hook: name, error: `${e}` }); }
                const us = nowUs() - t0;
                if (++costCalls <= COST_LOGS || costCalls % COST_EVERY === 0) log({ t: "hp-text-cost", hook: name, n: costCalls, us });
                if (us >= 1000) perfMark(`hp-text:${Math.round(us / 1000)}`);
            }
        });
    }
    log({ t: "hp-text-ready", textOffset });
}
