// 렉 계측 (PC 9ee7036 "원인을 계측으로 확정" 이식). 메인 스레드가 오래 막힌 프레임과 그 원인 후보를 mod.log에 남긴다.
//  - frame-hitch: UnityGameManager.LoopUpdate 사이 간격이 HITCH_MS 이상 (한 프로세스 최대 MAX_HITCH 줄)
//  - audio-update: RuntimeAudioClipLoader.Manager.Update(백그라운드 디코드가 끝난 클립에 SetData) 한 번이 SLOW_MS 이상
import { log } from "./log.js";
import { gameImage } from "./il2cpp.js";

const HITCH_MS = 100;
const SLOW_MS = 8;
const MAX_HITCH = 100;

let last = 0;
let hitches = 0;

/** 다른 모듈이 "방금 무엇을 했는지"를 남기면 다음 hitch 줄에 같이 찍힌다. */
const recent: string[] = [];
export function perfMark(what: string): void {
    recent.push(what);
    if (recent.length > 8) recent.shift();
}

export function installPerf(): void {
    const asm = gameImage();
    const loop = asm.class("Assets.Scripts.PeroTools.Managers.UnityGameManager").method("LoopUpdate", 0);
    Interceptor.attach(loop.virtualAddress, {
        onEnter() {
            const now = Date.now();
            if (last !== 0 && now - last >= HITCH_MS && hitches < MAX_HITCH) {
                hitches++;
                log({ t: "frame-hitch", ms: now - last, recent: recent.slice() });
            }
            recent.length = 0;
            last = now;
        }
    });

    let manager: Il2Cpp.Class | null = null;
    for (const a of Il2Cpp.domain.assemblies) { manager = a.image.tryClass("RuntimeAudioClipLoader.Manager"); if (manager) break; }
    if (manager) {
        Interceptor.attach(manager.method("Update", 0).virtualAddress, {
            onEnter() { (this as any).t = Date.now(); },
            onLeave() {
                const ms = Date.now() - (this as any).t;
                if (ms >= SLOW_MS) { log({ t: "audio-update", ms }); perfMark(`audio-update:${ms}`); }
            }
        });
    }
    log({ t: "perf-ready", hitchMs: HITCH_MS });
}
