// 오토 플레이 (PC AutoPlayPatch.cs 이식본).
// DBSkill.SetAutoPlay(bool) 및 DBSkill.get_isAutoPlay()를 후킹하고,
// 배틀 시작 시 GlobalDataBase.get_dbSkill().SetAutoPlay(true)를 직접 호출하여
// 커스텀 곡 info.txt의 '오토플레이 = 활성화' 또는 전역 오토 설정 시 자동으로 노트를 연주합니다.
import { log, guard } from "./log.js";
import { battleSong, currentCustomSong } from "./customChart.js";

const RVA = {
    get_dbSkill: 0x1CAB018,       // Assets.Scripts.Database.GlobalDataBase.get_dbSkill() -> DBSkill
    SetAutoPlay: 0x20D2474,       // DBSkill.SetAutoPlay(bool enable)
    get_isAutoPlay: 0x20D246C     // DBSkill.get_isAutoPlay() -> bool
};

let globalAutoPlay = false;

export function setGlobalAutoPlay(enable: boolean): void {
    globalAutoPlay = enable;
    log({ t: "autoplay-global", enable });
}

export function shouldAutoPlay(): boolean {
    if (globalAutoPlay) return true;
    const song = battleSong() || currentCustomSong();
    if (song && song.manifest && song.manifest.autoPlay === true) {
        return true;
    }
    return false;
}

export function applyAutoPlay(enable: boolean): void {
    guard("apply-autoplay", () => {
        const base = Il2Cpp.module.base;
        const getDbSkill = new NativeFunction(base.add(RVA.get_dbSkill), "pointer", []);
        const setAutoPlay = new NativeFunction(base.add(RVA.SetAutoPlay), "void", ["pointer", "bool"]);

        const dbSkill = getDbSkill();
        if (!dbSkill.isNull()) {
            setAutoPlay(dbSkill, enable ? 1 : 0);
            log({ t: "autoplay-applied", enable, dbSkill: dbSkill.toString() });
        } else {
            log({ t: "autoplay-apply-failed", reason: "dbSkill is null" });
        }
    });
}

export function installAutoPlay(): void {
    const base = Il2Cpp.module.base;

    // DBSkill.SetAutoPlay(bool enable) 인자 가로채기
    Interceptor.attach(base.add(RVA.SetAutoPlay), {
        onEnter(args) {
            if (shouldAutoPlay()) {
                args[1] = ptr(1); // enable = true
                log({ t: "autoplay-engaged", reason: "SetAutoPlay" });
            }
        }
    });

    // DBSkill.get_isAutoPlay() 반환값 덮어쓰기
    Interceptor.attach(base.add(RVA.get_isAutoPlay), {
        onLeave(ret) {
            if (shouldAutoPlay()) {
                ret.replace(ptr(1));
            }
        }
    });

    log({ t: "autoplay-ready" });
}
