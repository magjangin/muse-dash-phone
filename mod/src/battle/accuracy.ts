// 커스텀 곡 정확도 (battle.ts에서 분리, 2026-11-13).
import { log } from "../log.js";
import { gameClass } from "../il2cpp.js";
import { battleSong } from "../customChart.js";
import { lastCounts } from "../chart/inject.js";

// TaskStageTarget 집계 (dump.cs)
const TST = { energy: 0x10, music: 0x14, miss: 0x5C, great: 0x64, perfect: 0x68, jumpOver: 0x6C };

// 커스텀 곡 정확도 (PC APModPatch.Accuracy.cs): (PERFECT + GREAT/2 + 기어 통과 + 하트 + 음표) / (표준 + 기어 + 하트 + 음표).
// 게임 공식 계산은 우리 차트의 음표 개수를 몰라 전부 퍼펙트여도 100%가 안 나온다(neon 오토 98.67%, logs/24_screen_now.png).
// 다른 훅 안에서 GetTrueAccuracy를 부르면 Frida가 그 호출엔 훅을 걸지 않아 게임 원래 값이 나온다 → records.ts는 이걸 직접 부른다.
export function customAccuracy(self: NativePointer, withItems: boolean): number {
    const read = (off: number) => self.add(off).readS32();
    const perfect = read(TST.perfect), great = read(TST.great), miss = read(TST.miss);
    const c = lastCounts;
    const denominator = withItems ? c.standard + c.gears + c.hearts + c.blue : c.standard;
    if (denominator > 0) {
        const numerator = perfect + great * 0.5 + (withItems ? read(TST.jumpOver) + read(TST.energy) + read(TST.music) : 0);
        return Math.min(1, numerator / denominator);
    }
    const total = perfect + great + miss;
    return total > 0 ? (perfect + great * 0.5) / total : 1;
}

export function installAccuracy(): void {
    const Target = gameClass("Assets.Scripts.GameCore.HostComponent.TaskStageTarget");
    const calc = customAccuracy;
    for (const [name, withItems] of [["GetTrueAccuracy", false], ["GetTrueAccuracyNew", true]] as [string, boolean][]) {
        const addr = Target.method(name, 0).virtualAddress;
        const original = new NativeFunction(addr, "float", ["pointer", "pointer"]);
        let logged = false;
        Interceptor.replace(addr, new NativeCallback((self: NativePointer, method: NativePointer) => {
            if (!battleSong()) return original(self, method) as number;
            const value = calc(self, withItems);
            if (!logged) { logged = true; log({ t: "accuracy", name, value, original: original(self, method), counts: lastCounts }); }
            return value;
        }, "float", ["pointer", "pointer"]));
    }
}
