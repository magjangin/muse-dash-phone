// 크리스마스 연출을 날짜와 상관없이 켜기 (PC Patches/Scene/ChristmasFestivalPatch.cs 이식, 1f6270e·d810e4d).
//
// 게임의 판정 (PC ISIL 확인, 이 빌드 dump.cs에도 같은 메서드):
//  - GameMusicScene.SceneFestival(name) 0x1D5026C: name == "scene_05"이고 [12월 24·25일 또는 uid 0-47/38-1]이면 "scene_05_christmas".
//    날짜는 BattleHelper.isChristmas가 아니라 DateTime.Now를 직접 본다 → 따로 걸어야 한다. LoadScene이 씬마다 부른다.
//  - Boss.BossFestival(name) 0x1B9E23C: name == "0501_boss"이고 [isChristmas 또는 uid 0-47/38-1]이면 "0501_boss_christmas".
//  - BattleHelper.get_isChristmas 0x1D356A8: 12월 24·25일인지. 보스 외에 GameInit.SpecialLogic·ItemManager.ChristmasItemLogic·
//    MainManager.InitLoading도 쓴다.
//
// 곡별 옵션(info.txt '크리스마스 배경 = 활성화'): 그 커스텀 곡의 배경·보스만 바꾼다. isChristmas는 곡과 무관한 곳(아이템·로딩)도
//   쓰므로 곡 옵션으로는 건드리지 않는다.
// 전역 설정(config.txt '강제크리스마스=true'): isChristmas를 참으로, 공식 곡의 배경·보스도 바꾼다. 커스텀 곡에는 새지 않게
//   곡 옵션이 켜진 곡만 바꾼다(PC d810e4d).
import { guard, log } from "./log.js";
import { pinnedString, readIl2CppString } from "./native.js";
import { currentConfig } from "./config.js";
import { currentCustomSong } from "./customChart.js";
import { gameClass } from "./il2cpp.js";

export const SCENE05 = "scene_05";
export const SCENE05_CHRISTMAS = "scene_05_christmas";
export const BOSS05 = "0501_boss";
export const BOSS05_CHRISTMAS = "0501_boss_christmas";

/** 지금 곡에서 크리스마스 배경·보스를 강제로 쓸지. 판정 근거를 돌려준다(아니면 null). */
export function christmasReason(): string | null {
    const song = currentCustomSong();
    if (song) return song.manifest.christmasScene === true ? `info.txt (${song.name})` : null;
    return currentConfig.forceChristmas ? "강제크리스마스 (공식 곡)" : null;
}

/** 크리스마스 곡이면 5번 보스(이름이 0501_boss이거나 씬 5)를 크리스마스 보스로 바꾼다. 아니면 그대로. */
export function christmasBoss(name: string, scene: number, force: boolean): { name: string; scene: number } {
    if (force && (name === BOSS05 || scene === 5)) return { name: BOSS05_CHRISTMAS, scene: 5 };
    return { name, scene };
}


/** string → string 메서드의 반환을 크리스마스 판으로 (원본은 그대로 부르고 결과만 바꿈 = PC Postfix). */
function festival(method: Il2Cpp.Method, tag: string, accepts: (name: string, result: string) => boolean, to: string): void {
    let logged = 0;
    Interceptor.attach(method.virtualAddress, {
        onEnter(args) { (this as any).name = args[1]; },
        onLeave(ret) {
            guard(tag, () => {
                const name = readIl2CppString((this as any).name);
                const result = readIl2CppString(ret);
                if (!name || !result || !accepts(name, result)) return;
                const reason = christmasReason();
                if (!reason) return;
                ret.replace(pinnedString(to));
                if (logged++ < 8) log({ t: tag, from: result, to, reason });
            });
        }
    });
}

export function installChristmas(): void {
    // 날짜 판정: 전역 설정이 켜졌을 때만 참으로 (원래 참이면 그대로).
    const isChristmas = gameClass("Assets.Scripts.Database.BattleHelper").method("get_isChristmas");
    let loggedDate = false;
    Interceptor.attach(isChristmas.virtualAddress, {
        onLeave(ret) {
            if (!currentConfig.forceChristmas || (ret.toInt32() & 0xFF) !== 0) return;
            ret.replace(ptr(1));
            if (!loggedDate) { loggedDate = true; log({ t: "christmas-date", forced: true }); }
        }
    });

    // 배경: 크리스마스 판은 5번 씬에만 있다. 게임이 이미 바꿨으면(진짜 12/24·25 등) 손대지 않는다.
    festival(gameClass("GameLogic.GameMusicScene").method("SceneFestival", 1), "christmas-scene",
        (name, result) => name === SCENE05 && result === SCENE05, SCENE05_CHRISTMAS);
    // 보스
    festival(gameClass("Boss").method("BossFestival", 1), "christmas-boss",
        (name, result) => (name === BOSS05 || name === BOSS05_CHRISTMAS) && (result === BOSS05 || result === BOSS05_CHRISTMAS),
        BOSS05_CHRISTMAS);

    log({ t: "christmas-ready" });
}
