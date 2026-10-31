// 피버 제어 모듈 (PC ChangeFeverValuePatch.cs 이식본).
// AbstractFeverManager.AddFever(int) (0x205D4F0) 및
// AbstractFeverManager.AddFever(ref MusicData, int) (0x205D418)를 후킹하여
// '피버충전금지' 설정 시 피버 게이지 충전을 차단합니다.
import { log } from "./log.js";
import { battleSong, currentCustomSong } from "./customChart.js";

const RVA = {
    AddFeverInt: 0x205D4F0,       // AbstractFeverManager.AddFever(int value)
    AddFeverData: 0x205D418,      // AbstractFeverManager.AddFever(ref MusicData md, int result)
    InvokeFever: 0x205D644        // AbstractFeverManager.InvokeFever() -> bool
};

let globalBlockFever = false;

export function setGlobalBlockFever(block: boolean): void {
    globalBlockFever = block;
    log({ t: "fever-block-global", block });
}

export function shouldBlockFever(): boolean {
    if (globalBlockFever) return true;
    const song = battleSong() || currentCustomSong();
    if (song && song.manifest && song.manifest.blockFever === true) {
        return true;
    }
    return false;
}

export function installFever(): void {
    const base = Il2Cpp.module.base;

    // AddFever(int value) 인자 가로채기
    Interceptor.attach(base.add(RVA.AddFeverInt), {
        onEnter(args) {
            if (shouldBlockFever()) {
                args[1] = ptr(0); // value = 0 (피버 게이지 충전 차단)
            }
        }
    });

    // AddFever(ref MusicData md, int result) 가로채기
    Interceptor.attach(base.add(RVA.AddFeverData), {
        onEnter(args) {
            if (shouldBlockFever()) {
                // result = 0 (None)
                args[2] = ptr(0);
            }
        }
    });

    log({ t: "fever-ready" });
}
