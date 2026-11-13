// 보스: 시작 보스를 BMS 첫 in 보스로, 교체 보스 미리 생성, swap 키 실행, 씬 전환 보스 교체 막기 (battle.ts에서 분리, 2026-11-13).
import { guard, log } from "../log.js";
import { pinnedString, readIl2CppString } from "../native.js";
import { gameClass } from "../il2cpp.js";
import { battleSong, currentCustomSong } from "../customChart.js";
import { bmsSwapTargets, firstBmsBoss } from "../chart/spec.js";
import { battleDifficulty } from "../hwa/difficulty.js";
import { chartForDifficulty } from "../hwa/library.js";
import { christmasBoss, christmasReason } from "../christmas.js";

const BOSS = { curBossObject: 0x18, bossObjects: 0x20 };

function setActive(go: Il2Cpp.Object | null): void {
    if (!go || go.isNull()) return;
    if (!go.method<boolean>("get_activeSelf").invoke()) go.method("SetActive").invoke(true);
    const parent = go.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.Object>("get_parent").invoke();
    if (parent && !parent.isNull()) {
        const pgo = parent.method<Il2Cpp.Object>("get_gameObject").invoke();
        if (!pgo.method<boolean>("get_activeSelf").invoke()) pgo.method("SetActive").invoke(true);
    }
}

function curBossObject(boss: Il2Cpp.Object): Il2Cpp.Object | null {
    const p = boss.handle.add(BOSS.curBossObject).readPointer();
    return p.isNull() ? null : new Il2Cpp.Object(p);
}

function hasBossScene(boss: Il2Cpp.Object, scene: number): boolean {
    const p = boss.handle.add(BOSS.bossObjects).readPointer();
    if (p.isNull()) return false;
    return new Il2Cpp.Object(p).method<boolean>("ContainsKey").invoke(scene);
}

export function installBoss(): void {
    const Boss = gameClass("Boss");
    let dynamicSwap = false;

    // 배틀 시작 보스 → BMS 첫 in 보스(없으면 기본 보스), 교체될 보스들은 미리 만들고 꺼 둔다.
    Interceptor.attach(Boss.method("InitBossObject", 3).virtualAddress, {
        onEnter(args) {
            if (dynamicSwap) return;
            const song = currentCustomSong();
            if (!song) return;
            guard("boss-init", () => {
                const boss = new Il2Cpp.Object(args[0]);
                const from = { name: readIl2CppString(args[1]) ?? "", scene: args[2].toInt32() };
                const chart = chartForDifficulty(song, battleDifficulty());
                const first = firstBmsBoss(chart);
                // 크리스마스 곡(info.txt '크리스마스 배경')이면 5번 보스를 크리스마스 보스로 (PC d810e4d)
                const xmas = christmasReason();
                if (first) {
                    for (const target of bmsSwapTargets(chart)) {
                        const t = christmasBoss(target.name, target.scene, xmas !== null);
                        if (hasBossScene(boss, t.scene)) continue;   // 이번 배틀 보스 표에 이미 있으면 건너뜀
                        dynamicSwap = true;
                        try {
                            boss.method("InitBossObject", 3).invoke(Il2Cpp.string(t.name), t.scene, false);
                            const cur = curBossObject(boss);
                            if (cur) cur.method("SetActive").invoke(false);
                            log({ t: "boss-prewarm", name: t.name, scene: t.scene });
                        } finally {
                            dynamicSwap = false;
                        }
                    }
                }
                // BMS에 보스가 없으면 숙주 씬이 부른 보스를 그대로 둔다. PC는 예전엔 0701로 바꿨지만 지금은 규칙이 비었다(d810e4d).
                // 크리스마스 곡이면 고른 보스가 5번일 때 크리스마스 보스로. PC는 숙주 보스가 5번일 때만 BMS 보스까지 바꾸지만,
                // 여기선 숙주와 상관없이 고른 보스 기준으로 본다(5번 BMS 보스가 숙주 씬 때문에 크리스마스 판을 놓치지 않게).
                const picked = first ?? from;
                const to = christmasBoss(picked.name, picked.scene, xmas !== null);
                if (to.name === from.name && to.scene === from.scene) {
                    log({ t: "boss-init", song: song.name, from, to, source: first ? "bms" : "host", christmas: xmas });
                    return;
                }
                args[1] = pinnedString(to.name);
                args[2] = ptr(to.scene);
                log({ t: "boss-init", song: song.name, from, to, source: first ? "bms" : "host", christmas: xmas });
            });
        }
    });

    // swap 키: 원본 Play는 이 키를 모른다 → 보스를 교체한 뒤 키를 "in"으로 바꿔 원본이 등장 연출을 하게 한다.
    Interceptor.attach(Boss.method("Play", 2).virtualAddress, {
        onEnter(args) {
            const key = readIl2CppString(args[1]);
            if (!key || !key.startsWith("swap:") || !battleSong()) return;
            guard("boss-swap", () => {
                const parts = key.split(":");
                const rawScene = parseInt(parts[2] ?? "", 10);
                if (parts.length < 3 || isNaN(rawScene)) {
                    log({ t: "boss-swap-bad-key", key });
                    return;
                }
                const { name, scene } = christmasBoss(parts[1], rawScene, christmasReason() !== null);
                const boss = new Il2Cpp.Object(args[0]);
                setActive(curBossObject(boss));      // out으로 꺼진 보스를 깨운다
                dynamicSwap = true;
                try {
                    boss.method("InitBossObject", 3).invoke(Il2Cpp.string(name), scene, true);
                } finally {
                    dynamicSwap = false;
                }
                setActive(curBossObject(boss));      // 새 보스 오브젝트도 깨운다
                args[1] = pinnedString("in");
                log({ t: "boss-swap", name, scene });
            });
        }
    });

    // 씬 전환 시 보스 교체 방지: 커스텀 곡일 때는 배경만 바뀌고 현재 보스를 끄거나 교체하지 않음 (PC Boss_SceneBossChange_Patch)
    const sceneBossChange = Boss.method("SceneBossChange", 1).virtualAddress;
    const sceneBossChangeOriginal = new NativeFunction(sceneBossChange, "void", ["pointer", "int", "pointer"]);
    Interceptor.replace(sceneBossChange, new NativeCallback((self: NativePointer, idx: number, method: NativePointer) => {
        if (battleSong() && !dynamicSwap) {
            log({ t: "boss-scene-change-skip", idx });
            return;
        }
        sceneBossChangeOriginal(self, idx, method);
    }, "void", ["pointer", "int", "pointer"]));
}
