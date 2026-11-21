// 진행바 (PC 모드 Patches/Battle/UI/ProgressBarPatch.cs + HwaSyncManager 이식, PC b0cf0af·ffcdb2c 2026-11-21 반영).
// 숙주 곡보다 길거나 짧은 커스텀 곡에서 진행바가 숙주 길이로 돌지 않게, 진행률 = 게임 시계 / 커스텀 음원 길이로 바꾼다.
//  - StageBattleComponent.GetTimeProgress() 반환값
//  - PnlBattle.<MusicProgressInit>b__48_1(float) — 진행바 DOTween이 매 프레임 넣는 값
//  - 매 프레임 sldProgress.value 직접 갱신 (숙주 곡 트윈이 먼저 끝나 멈춘 뒤에도 계속 가게.
//    PC는 0.1초 간격이었다가 트윈이 끝난 뒤 계단처럼 보여 매 프레임으로 바꿨다)
//  - StageBattleComponent.End 뒤에는 100%로 두고 다음 배틀까지 유지
//
// 왜 게임 시계 ÷ 음원 길이인가: 게임의 GetTimeProgress도 timeFromMusicStart / bgm.clip.length이고, 게임은
// timeFromMusicStart ≥ bgm.clip.length가 되는 프레임에 End를 예약한다(PC GameMusic.BattleEnd ISIL, 2026-11-21).
// Android는 그 클립이 곧 커스텀 OGG를 디코드한 것이라 같은 시계·같은 분모를 쓰면 End 순간 정확히 100%가 된다.
// 예전엔 max(OGG, 마지막 노트)를 분모로 쓰고, isInGame이 꺼지면(End 예약 순간) 갱신을 멈춰서 다 차기 전에 멈출 수 있었다.
// 게임 시계(Stopwatch)는 음악 시작 전엔 지난 배틀 값이 남을 수 있어 FixedOffset(게임이 음악을 시작) 뒤에만 쓴다.
import { log } from "./log.js";
import { battleSerial, battleSong, progressDuration } from "./customChart.js";
import { onFrame } from "./frame.js";
import { gameClass } from "./il2cpp.js";
import { nowUs } from "./native.js";
import { perfMark } from "./perf.js";

let stagePtr: NativePointer | null = null;
let stageSerial = -1;
let getTime: NativeFunction<number, [NativePointerValue, NativePointerValue]> | null = null;
let musicStartedSerial = -1;   // 이 배틀(serial)에서 게임이 음악을 시작했는지 (FixedOffset)
let endedSerial = -1;          // 이 배틀에서 End가 불렸는지
let slider: Il2Cpp.Object | null = null;
let sliderSerial = -1;
let setValue: NativeFunction<void, [NativePointerValue, number, NativePointerValue]> | null = null;

// 매 프레임 도는 경로라 브리지 호출(메서드 찾기·래퍼)을 배틀당 한 번으로 줄이고 나머지는 NativeFunction으로 부른다.
// 처음 판(브리지로 매번)은 프레임당 200~420 µs였다(2026-11-21 il vento d'oro, progress-cost).

/** 커스텀 곡 배틀 중이면 0~1 진행률, 아니면 null. */
export function customProgress(): number | null {
    if (!battleSong()) return null;
    const serial = battleSerial();
    if (endedSerial === serial) return 1;
    if (musicStartedSerial !== serial) return null;
    const duration = progressDuration();
    if (duration <= 1) return null;
    if (stageSerial !== serial || stagePtr === null || getTime === null) {
        const Stage = gameClass("FormulaBase.StageBattleComponent");
        const stage = Stage.method<Il2Cpp.Object>("get_instance").invoke();
        if (!stage || stage.isNull()) return null;
        stagePtr = stage.handle;
        stageSerial = serial;
        if (getTime === null) getTime = new NativeFunction(Stage.method("get_timeFromMusicStart", 0).virtualAddress, "float", ["pointer", "pointer"]);
    }
    // isInGame은 보지 않는다: 게임이 End를 예약하는 순간 꺼서, 보면 마지막 몇 프레임을 못 채운다.
    const elapsed = getTime(stagePtr, NULL);
    return Math.min(1, Math.max(0, elapsed / duration));
}

function currentSlider(PnlBattle: Il2Cpp.Class): Il2Cpp.Object | null {
    const serial = battleSerial();
    if (sliderSerial === serial && slider && !slider.isNull()) return slider;
    const comps = PnlBattle.method<Il2Cpp.Object>("get_instance").invoke()?.method<Il2Cpp.Object>("get_CurrentBattleUIComp").invoke();
    const s = comps?.field<Il2Cpp.Object>("sldProgress").value;
    if (!s || s.isNull()) return null;
    slider = s;
    sliderSerial = serial;
    // 실제 클래스(UnityEngine.UI.Slider)의 set_value 구현을 직접 부른다.
    setValue = new NativeFunction(s.method("set_value", 1).virtualAddress, "void", ["pointer", "float", "pointer"]);
    return s;
}

function setSlider(s: Il2Cpp.Object, value: number): void {
    if (setValue) setValue(s.handle, value, NULL);
    else s.method("set_value").invoke(value);
}

export function installProgress(): void {
    const Stage = gameClass("FormulaBase.StageBattleComponent");
    const getTimeProgress = Stage.method("GetTimeProgress", 0).virtualAddress;
    const getTimeProgressOriginal = new NativeFunction(getTimeProgress, "float", ["pointer", "pointer"]);
    Interceptor.replace(getTimeProgress, new NativeCallback((self: NativePointer, method: NativePointer) => {
        const r = customProgress();
        return r === null ? (getTimeProgressOriginal(self, method) as number) : r;
    }, "float", ["pointer", "pointer"]));

    const PnlBattle = gameClass("Assets.Scripts.UI.Panels.PnlBattle");
    const setter = PnlBattle.method("<MusicProgressInit>b__48_1", 1).virtualAddress;
    const setterOriginal = new NativeFunction(setter, "void", ["pointer", "float", "pointer"]);
    Interceptor.replace(setter, new NativeCallback((self: NativePointer, value: number, method: NativePointer) => {
        const r = customProgress();
        setterOriginal(self, r === null ? value : r, method);
    }, "void", ["pointer", "float", "pointer"]));

    // 게임이 음악을 시작한 때 (sync.ts가 offset을 덮는 같은 함수, 여러 attach 가능)
    Interceptor.attach(Stage.method("FixedOffset").virtualAddress, {
        onLeave() {
            if (!battleSong() || musicStartedSerial === battleSerial()) return;
            musicStartedSerial = battleSerial();
            log({ t: "progress-music-start", duration: progressDuration() });
        }
    });

    // 배틀 끝: 진행바를 끝까지 채우고 다음 배틀까지 둔다 (PC FillOnBattleEnd)
    Interceptor.attach(Stage.method("End").virtualAddress, {
        onEnter() {
            if (!battleSong()) return;
            const serial = battleSerial();
            if (endedSerial === serial) return;
            let before: number | null = null;
            try { before = customProgress(); } catch (e) { /* 로그용 */ }
            endedSerial = serial;
            (this as any).fill = true;
            (this as any).before = before;
        },
        onLeave() {
            if (!(this as any).fill) return;
            let ok = false;
            try {
                const s = currentSlider(PnlBattle);
                if (s) { setSlider(s, 1); ok = true; }
            } catch (e) { /* 아래 로그로 */ }
            log({ t: "progress-end", before: (this as any).before, duration: progressDuration(), slider: ok });
        }
    });

    // 트윈이 끝난 뒤에도 진행바를 매 프레임 움직인다 (PC HwaSyncManager)
    let logged = -1, costLogs = 0;
    onFrame("progress", () => {
        if (!battleSong()) return;
        const t0 = nowUs();
        const r = customProgress();
        if (r === null) return;
        const s = currentSlider(PnlBattle);
        if (!s) return;
        setSlider(s, r);
        const us = nowUs() - t0;
        if (logged !== battleSerial()) {
            logged = battleSerial();
            costLogs = 0;
            log({ t: "progress-drive", duration: progressDuration(), ratio: r });
        }
        if (costLogs < 4 || (costLogs % 600 === 0)) log({ t: "progress-cost", us, ratio: r, n: costLogs });
        costLogs++;
        if (us > 1000) perfMark(`progress:${(us / 1000).toFixed(1)}`);
    });
    log({ t: "progress-ready" });
}
