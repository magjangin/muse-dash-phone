// 매 프레임 콜백 (메인 스레드). UnityGameManager.LoopUpdate 0x1E62D24 = 게임의 프레임 Update 분배기.
// GameMusicScene.Run은 GameStart에서 한 번만 불려 프레임 훅으로 못 쓴다(2026-10-31 실측: 진행바·싱크 샘플이 한 번도 안 돎).
import { log } from "./log.js";

type FrameCallback = () => void;
const callbacks: { name: string; fn: FrameCallback; failed: boolean }[] = [];
let installed = false;

export function onFrame(name: string, fn: FrameCallback): void {
    callbacks.push({ name, fn, failed: false });
    if (installed) return;
    installed = true;
    const loop = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.PeroTools.Managers.UnityGameManager").method("LoopUpdate", 0);
    Interceptor.attach(loop.virtualAddress, {
        onLeave() {
            for (const c of callbacks) {
                if (c.failed) continue;
                try {
                    c.fn();
                } catch (e) {
                    c.failed = true;   // 한 기능의 예외가 매 프레임 로그를 쏟지 않게 그 기능만 끈다
                    log({ t: "frame-error", name: c.name, error: `${e}` });
                }
            }
        }
    });
}
