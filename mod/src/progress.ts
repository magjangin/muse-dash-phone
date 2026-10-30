// 진행바 (PC 모드 Patches/Battle/UI/ProgressBarPatch.cs + HwaSyncManager.HandleBattleSynchronization 이식).
// 숙주 곡보다 길거나 짧은 커스텀 곡에서 진행바가 숙주 길이로 돌지 않게, 진행률 = 경과 / max(OGG 길이, 마지막 노트 끝)으로 바꾼다.
//  - StageBattleComponent.GetTimeProgress() 반환값
//  - PnlBattle.<MusicProgressInit>b__48_1(float) — 진행바 DOTween이 매 프레임 넣는 값
//  - 0.1초마다 sldProgress.value 직접 갱신 (숙주 곡 트윈이 먼저 끝나 멈춘 뒤에도 계속 가게)
import { log } from "./log.js";
import { battleDuration, battleSong } from "./customChart.js";
import { onFrame } from "./frame.js";

const asm = () => Il2Cpp.domain.assembly("Assembly-CSharp").image;
const UPDATE_MS = 100;

let stage: Il2Cpp.Object | null = null;

/** 커스텀 곡 배틀 중이면 0~1 진행률, 아니면 null. */
export function customProgress(): number | null {
    if (!battleSong()) return null;
    const duration = battleDuration();
    if (duration <= 1) return null;
    if (!stage || stage.isNull()) stage = asm().class("FormulaBase.StageBattleComponent").method<Il2Cpp.Object>("get_instance").invoke();
    if (!stage.field<boolean>("isInGame").value) return null;
    const elapsed = stage.method<number>("get_timeFromMusicStart").invoke();
    return Math.min(1, Math.max(0, elapsed / duration));
}

export function installProgress(): void {
    const Stage = asm().class("FormulaBase.StageBattleComponent");
    const getTimeProgress = Stage.method("GetTimeProgress", 0).virtualAddress;
    const getTimeProgressOriginal = new NativeFunction(getTimeProgress, "float", ["pointer", "pointer"]);
    Interceptor.replace(getTimeProgress, new NativeCallback((self: NativePointer, method: NativePointer) => {
        const r = customProgress();
        return r === null ? (getTimeProgressOriginal(self, method) as number) : r;
    }, "float", ["pointer", "pointer"]));

    const PnlBattle = asm().class("Assets.Scripts.UI.Panels.PnlBattle");
    const setter = PnlBattle.method("<MusicProgressInit>b__48_1", 1).virtualAddress;
    const setterOriginal = new NativeFunction(setter, "void", ["pointer", "float", "pointer"]);
    Interceptor.replace(setter, new NativeCallback((self: NativePointer, value: number, method: NativePointer) => {
        const r = customProgress();
        setterOriginal(self, r === null ? value : r, method);
    }, "void", ["pointer", "float", "pointer"]));

    // 트윈이 끝난 뒤에도 진행바를 계속 움직인다 (PC HwaSyncManager, 0.1초 간격)
    let next = 0, logged = false;
    onFrame("progress", () => {
        const now = Date.now();
        if (now < next) return;
        next = now + UPDATE_MS;
        const r = customProgress();
        if (r === null) return;
        const comps = PnlBattle.method<Il2Cpp.Object>("get_instance").invoke()?.method<Il2Cpp.Object>("get_CurrentBattleUIComp").invoke();
        const slider = comps?.field<Il2Cpp.Object>("sldProgress").value;
        if (!slider || slider.isNull()) return;
        slider.method("set_value").invoke(r);
        if (!logged) { logged = true; log({ t: "progress-drive", duration: battleDuration(), ratio: r }); }
    });
    log({ t: "progress-ready" });
}
