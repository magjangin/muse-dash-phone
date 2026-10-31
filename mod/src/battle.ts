// 커스텀 곡 배틀 핵심 파이프라인 (PC 모드 Patches/Battle/Mechanics/BossPatch.cs, Patches/Scene/GameMusicScene*Patch.cs,
// SceneFlowPatch.cs, NoteAnimationSyncPatch.cs 이식). 전부 커스텀 곡일 때만 동작하고 순정 곡은 원본 그대로.
//  - 보스: Boss.Play("swap:<보스>:<씬>")를 InitBossObject + Play("in")으로 실행, 시작 보스를 BMS 첫 in 보스로, 교체 보스 미리 생성
//  - 씬: GameMusicScene.LoadScene을 info.txt 씬 번호로, 씬 전환은 배경만(IsIgnoreCurrentNoteChecking=true, ChangeNote 차단)
//  - 타이머: GameMusicScene.InitTimer 한도를 곡 길이+30초로
//  - 노트 애니메이션: 늦게 스폰된 노트의 Spine 시간을 즉시 보정
import { guard, log } from "./log.js";
import { pinnedString, readDecimal, readIl2CppString, writeDecimal } from "./native.js";
import { battleDuration, battleSong, currentCustomSong } from "./customChart.js";
import { bmsSwapTargets, firstBmsBoss } from "./chart/spec.js";
import { lastCounts } from "./chart/inject.js";
import { onFrame } from "./frame.js";

// 보스 정보가 BMS에 없을 때 PC 모드가 쓰던 기본 보스 (BossRewriteRules)
const FALLBACK_BOSS = { name: "0701_boss", scene: 7 };
const BOSS = { curBossObject: 0x18, bossObjects: 0x20 };
// SpineActionController.m_MusicData(struct) 0xF0 + MusicData.dt 0x138 / showTick 0x14C
const SPINE_MUSIC_DATA = 0xF0, MD_DT = 0x138, MD_SHOW_TICK = 0x14C;

const asm = () => Il2Cpp.domain.assembly("Assembly-CSharp").image;

/** bool 반환 메서드를 조건이 참일 때만 true로 (원본은 안 부름). argTypes는 this·인자·MethodInfo* 순. */
function replaceBool(method: Il2Cpp.Method, argTypes: string[], when: () => boolean): void {
    const addr = method.virtualAddress;
    const original: any = new NativeFunction(addr, "bool", argTypes as any);
    const callback: any = (...args: any[]) => (when() ? 1 : (original(...args) ? 1 : 0));
    Interceptor.replace(addr, new NativeCallback(callback, "bool", argTypes as any));
}

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

function installBoss(): void {
    const Boss = asm().class("Boss");
    let dynamicSwap = false;

    // 배틀 시작 보스 → BMS 첫 in 보스(없으면 기본 보스), 교체될 보스들은 미리 만들고 꺼 둔다.
    Interceptor.attach(Boss.method("InitBossObject", 3).virtualAddress, {
        onEnter(args) {
            if (dynamicSwap) return;
            const song = currentCustomSong();
            if (!song) return;
            guard("boss-init", () => {
                const boss = new Il2Cpp.Object(args[0]);
                const from = { name: readIl2CppString(args[1]), scene: args[2].toInt32() };
                const first = firstBmsBoss(song.chart);
                if (first) {
                    for (const t of bmsSwapTargets(song.chart)) {
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
                const to = first ?? FALLBACK_BOSS;
                args[1] = pinnedString(to.name);
                args[2] = ptr(to.scene);
                log({ t: "boss-init", song: song.name, from, to, source: first ? "bms" : "fallback" });
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
                const scene = parseInt(parts[2] ?? "", 10);
                if (parts.length < 3 || isNaN(scene)) {
                    log({ t: "boss-swap-bad-key", key });
                    return;
                }
                const boss = new Il2Cpp.Object(args[0]);
                setActive(curBossObject(boss));      // out으로 꺼진 보스를 깨운다
                dynamicSwap = true;
                try {
                    boss.method("InitBossObject", 3).invoke(Il2Cpp.string(parts[1]), scene, true);
                } finally {
                    dynamicSwap = false;
                }
                setActive(curBossObject(boss));      // 새 보스 오브젝트도 깨운다
                args[1] = pinnedString("in");
                log({ t: "boss-swap", name: parts[1], scene });
            });
        }
    });
}

function installScene(): void {
    const GameMusicScene = asm().class("GameLogic.GameMusicScene");

    // 씬: info.txt 씬 번호로 (PC GameMusicScene_LoadScene_Patch)
    Interceptor.attach(GameMusicScene.method("LoadScene", 1).virtualAddress, {
        onEnter(args) {
            const song = currentCustomSong();
            const scene = song?.manifest.scene;
            if (!song || scene == null) return;
            const from = readIl2CppString(args[1]);
            const to = `scene_${String(scene).padStart(2, "0")}`;
            args[1] = pinnedString(to);
            log({ t: "scene-redirect", song: song.name, from, to });
        }
    });

    // 씬 전환은 배경만: 노트 정체(noteData/configData.note_uid)를 씬 기준으로 덮어쓰지 못하게 (PC SCENE_BACKGROUND_SWAP)
    replaceBool(asm().class("FormulaBase.StageBattleComponent").method("IsIgnoreCurrentNoteChecking", 1),
        ["pointer", "pointer", "pointer"], () => battleSong() !== null);
    replaceBool(GameMusicScene.method("IsIgnoreCurrentNoteChecking", 2),
        ["pointer", "int", "pointer", "pointer"], () => battleSong() !== null);

    // 씬 전환 노트가 노트 프리팹을 바꾸지 못하게 (PC SceneChangeController_ChangeNote_Patch)
    const changeNote = asm().class("SceneChangeController").method("ChangeNote", 1).virtualAddress;
    const changeNoteOriginal = new NativeFunction(changeNote, "void", ["pointer", "int", "pointer"]);
    Interceptor.replace(changeNote, new NativeCallback((self: NativePointer, sceneInfo: number, method: NativePointer) => {
        if (battleSong()) return;
        changeNoteOriginal(self, sceneInfo, method);
    }, "void", ["pointer", "int", "pointer"]));

    // 타이머: 숙주 곡보다 긴 커스텀 곡이 도중에 끝나지 않게 (PC GameMusicScene_InitTimer_Patch). Decimal 인자는 x1:x2.
    const scratch = Memory.alloc(16);
    Interceptor.attach(GameMusicScene.method("InitTimer", 1).virtualAddress, {
        onEnter(args) {
            if (!battleSong()) return;
            scratch.writePointer(args[1]);
            scratch.add(8).writePointer(args[2]);
            const current = readDecimal(scratch);
            const required = battleDuration() + 30;
            if (required > current) {
                writeDecimal(scratch, Math.ceil(required));
                args[1] = scratch.readPointer();
                args[2] = scratch.add(8).readPointer();
                log({ t: "timer-extend", from: current, to: Math.ceil(required) });
            }
        }
    });
}

// StageBattleComponent.<offset>k__BackingField. 음악 위치 = (경과 + delay − offset) × 샘플레이트 (get_getMusicOffset 0x1D602BC).
const STAGE_OFFSET = 0xA8;

function installOffset(): void {
    // info.txt offset (PC OffsetHookPatches). PC는 FixedOffset/FixedMusicOffset **Postfix**에서 offset을 덮는다:
    // 즉 그 판의 음악 시작 예약(GameStart: Delay(−delay + offset))과 첫 위치 맞춤(timeSamples)은 게임 설정의 사용자 보정값을 그대로 쓰고,
    // info.txt offset은 그 뒤(일시정지 해제 등)에만 쓰인다. 같은 순서로 해야 PC에서 맞춘 delay가 같은 뜻이 된다.
    // (처음 이식본은 FixedMusicOffset **진입**에서 덮어 첫 위치 맞춤부터 바뀌었다.)
    const Stage = asm().class("FormulaBase.StageBattleComponent");
    let logged = 0;
    let bgm: NativePointer | null = null;
    const apply = (self: NativePointer, where: string) => {
        const off = battleSong()?.manifest.offset;
        if (off == null) return;
        const before = self.add(STAGE_OFFSET).readFloat();
        self.add(STAGE_OFFSET).writeFloat(off);
        if (logged++ < 4) log({ t: "offset-override", where, before, offset: off });
    };
    Interceptor.attach(Stage.method("FixedOffset").virtualAddress, {
        onEnter(args) { (this as any).self = args[0]; },
        onLeave() { if (battleSong()) apply((this as any).self, "FixedOffset"); }
    });
    Interceptor.attach(Stage.method("FixedMusicOffset", 1).virtualAddress, {
        onEnter(args) { (this as any).self = args[0]; (this as any).bgm = args[1]; },
        onLeave() {
            if (!battleSong()) return;
            apply((this as any).self, "FixedMusicOffset");
            bgm = (this as any).bgm;
            if (logged > 6) return;
            try {
                const clip = new Il2Cpp.Object(bgm!).method<Il2Cpp.Object>("get_clip").invoke();
                // 기기 오디오 버퍼 지연 (출력 지연의 일부): bufferLength × numBuffers / outputSampleRate
                const lenNum = Memory.alloc(8);
                new NativeFunction(Il2Cpp.module.base.add(0x433CE8C), "void", ["pointer", "pointer", "pointer"])(lenNum, lenNum.add(4), NULL);
                // outputSampleRate 게터는 스트리핑됨 → 48kHz로 가정해 대략값만
                log({ t: "bgm-clip", frequency: clip.method<number>("get_frequency").invoke(), length: clip.method<number>("get_length").invoke(),
                    dspBuffer: lenNum.readS32(), dspBuffers: lenNum.add(4).readS32(),
                    dspLatencyMsAt48k: Math.round(lenNum.readS32() * lenNum.add(4).readS32() / 48000 * 1000) });
            } catch (e) { log({ t: "bgm-clip-error", error: `${e}` }); }
        }
    });
    // 음악 위치 vs 게임 시계 (5초마다 3번): 차이 = delay − offset 이어야 정상
    let samples = 0, nextAt = 0, stage: Il2Cpp.Object | null = null;
    onFrame("sync-sample", () => {
        if (!battleSong() || !bgm || samples >= 3) return;
        const now = Date.now();
        if (now < nextAt) return;
        nextAt = now + 5000;
        if (!stage || stage.isNull()) stage = Stage.method<Il2Cpp.Object>("get_instance").invoke();
        const game = stage.method<number>("get_timeFromMusicStart").invoke();
        const audio = new Il2Cpp.Object(bgm).method<number>("get_time").invoke();
        if (game < 1) return;
        samples++;
        log({ t: "sync-sample", game, audio, audioMinusGame: Math.round((audio - game) * 1000) / 1000 });
    });
}

function installNoteSync(): void {
    // 프레임 드랍 뒤 늦게 스폰된 Spine 노트가 오른쪽에 뒤처지는 문제: "in" 재생 직후 시간을 now - showTick으로 당긴다 (PC NoteAnimationSyncPatch).
    const Spine = asm().class("SpineActionController");
    const Stage = asm().class("FormulaBase.StageBattleComponent");
    let stage: Il2Cpp.Object | null = null;
    Interceptor.attach(Spine.method("PlayByKey", 2).virtualAddress, {
        onEnter(args) { (this as any).self = args[0]; (this as any).key = args[1]; },
        onLeave() {
            if (!battleSong()) return;
            const keyPtr: NativePointer = (this as any).key;
            if (keyPtr.isNull() || readIl2CppString(keyPtr) !== "in") return;
            try {
                if (!stage || stage.isNull()) stage = Stage.method<Il2Cpp.Object>("get_instance").invoke();
                if (!stage.field<boolean>("isInGame").value) return;
                const self: NativePointer = (this as any).self;
                const dt = readDecimal(self.add(SPINE_MUSIC_DATA + MD_DT));
                const showTick = readDecimal(self.add(SPINE_MUSIC_DATA + MD_SHOW_TICK));
                if (dt <= 0.05 || showTick <= 0) return;
                const lag = stage.method<number>("get_timeFromMusicStart").invoke() - showTick;
                if (lag <= 0.02 || lag >= dt * 0.85) return;
                const spine = new Il2Cpp.Object(self);
                spine.method("set_currentAnimationTime").invoke(lag);
                spine.method("ForceUpdateSkAnim", 1).invoke(false);
            } catch (e) {
                /* 동기화 실패는 무시 (PC도 삼킴) */
            }
        }
    });
}

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

function installAccuracy(): void {
    const Target = asm().class("Assets.Scripts.GameCore.HostComponent.TaskStageTarget");
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

export function installBattle(): void {
    guard("battle-accuracy", installAccuracy);
    guard("battle-boss", installBoss);
    guard("battle-scene", installScene);
    guard("battle-offset", installOffset);
    guard("battle-note-sync", installNoteSync);
    log({ t: "battle-ready" });
}
