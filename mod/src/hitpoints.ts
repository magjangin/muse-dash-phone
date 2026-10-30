// 판정 지점(HitPoints) 설치 (PC 모드 Patches/Battle/UI/ExperimentHitPointInstaller.cs 이식).
// 커스텀 곡은 LoadScene을 info.txt 씬으로 돌리는데, 그러면 씬 로더가 그 씬의 HitPoints_<씬> 인스턴스(판정선 앞의 과녁 고리)를
// 빠뜨린다(neon: scene_05→scene_01 뒤 고리 없음, logs/22_screen.png ↔ 숙주 씬 logs/12_screen_r3.png).
// 배틀 중 매 프레임(UnityGameManager.LoopUpdate, 메인 스레드) 0.5초마다 시도: SceneObjectController 아래에 HitPoints_<씬>(Clone)이
// 없으면 게임 원본 프리팹 HitPoints_<씬>을 복제해 붙이고, 다른 씬의 HitPoints 잔재는 지운다. 40번(약 20초) 실패하면 이번 판은 포기.
import { log } from "./log.js";
import { battleSerial, battleSong } from "./customChart.js";
import { onFrame } from "./frame.js";

const RETRY_MS = 500;
const MAX_ATTEMPTS = 40;

const core = () => Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;

let state = { installed: false, gaveUp: false, attempts: 0, next: 0, battleKey: "" };

function hitPointScene(name: string | null): number | null {
    const m = name ? /^HitPoints_(\d+)/i.exec(name) : null;
    return m ? parseInt(m[1], 10) : null;
}

function tryInstall(scene: number): boolean {
    const GameObject = core().class("UnityEngine.GameObject");
    const soc = GameObject.method<Il2Cpp.Object>("Find", 1).invoke(Il2Cpp.string("SceneObjectController"));
    if (!soc || soc.isNull()) return false;
    const parent = soc.method<Il2Cpp.Object>("get_transform").invoke();
    const prefabName = `HitPoints_${String(scene).padStart(2, "0")}`;
    const cloneName = `${prefabName}(Clone)`;

    const childCount = parent.method<number>("get_childCount").invoke();
    let active: Il2Cpp.Object | null = null;
    for (let i = 0; i < childCount; i++) {
        const go = parent.method<Il2Cpp.Object>("GetChild").invoke(i).method<Il2Cpp.Object>("get_gameObject").invoke();
        if (go.method<Il2Cpp.String>("get_name").invoke().content === cloneName) { active = go; break; }
    }
    let source = "existing";
    if (!active) {
        // 원본 프리팹(씬에 없는 비활성 에셋)을 찾는다
        const all = core().class("UnityEngine.Resources").method<Il2Cpp.Array<Il2Cpp.Object>>("FindObjectsOfTypeAll", 1)
            .invoke(GameObject.type.object);
        let prefab: Il2Cpp.Object | null = null;
        for (let i = 0; i < all.length; i++) {
            const o = all.get(i);
            if (o.method<Il2Cpp.String>("get_name").invoke().content === prefabName) { prefab = o; break; }
        }
        if (!prefab) return false;
        active = core().class("UnityEngine.Object").method<Il2Cpp.Object>("Instantiate", 1).overload("UnityEngine.Object").invoke(prefab);
        active.method("set_name").invoke(Il2Cpp.string(cloneName));
        active.method<Il2Cpp.Object>("get_transform").invoke().method("SetParent", 2).invoke(parent, false);
        active.method("SetActive").invoke(true);
        source = "instantiated";
    }
    // 다른 씬의 HitPoints 잔재 정리
    let removed = 0;
    for (let i = parent.method<number>("get_childCount").invoke() - 1; i >= 0; i--) {
        const go = parent.method<Il2Cpp.Object>("GetChild").invoke(i).method<Il2Cpp.Object>("get_gameObject").invoke();
        if (go.handle.equals(active.handle)) continue;
        if (hitPointScene(go.method<Il2Cpp.String>("get_name").invoke().content) !== null) {
            core().class("UnityEngine.Object").method("Destroy", 1).invoke(go);
            removed++;
        }
    }
    log({ t: "hitpoints", scene, source, removed });
    return true;
}

export function installHitPoints(): void {
    onFrame("hitpoints", () => {
        const song = battleSong();
        if (!song || song.manifest.scene == null) return;
        // 판이 바뀌면(재시작·다른 곡) 다시 시도
        const key = `${song.virtualUid}#${battleSerial()}`;
        if (state.battleKey !== key) state = { installed: false, gaveUp: false, attempts: 0, next: 0, battleKey: key };
        if (state.installed || state.gaveUp) return;
        const now = Date.now();
        if (now < state.next) return;
        state.next = now + RETRY_MS;
        if (++state.attempts > MAX_ATTEMPTS) {
            state.gaveUp = true;
            log({ t: "hitpoints-gave-up", scene: song.manifest.scene });
            return;
        }
        try {
            state.installed = tryInstall(song.manifest.scene);
        } catch (e) {
            log({ t: "hitpoints-error", error: `${e}` });
            state.gaveUp = true;
        }
    });
    log({ t: "hitpoints-ready" });
}
