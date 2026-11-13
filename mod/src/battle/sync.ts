// 싱크: info.txt offset 덮기·음악/게임 시계 표본, 늦게 스폰된 노트 애니메이션 보정 (battle.ts에서 분리, 2026-11-13).
import { log } from "../log.js";
import { readDecimal, readIl2CppString } from "../native.js";
import { gameClass } from "../il2cpp.js";
import { battleSong } from "../customChart.js";
import { onFrame } from "../frame.js";

// SpineActionController.m_MusicData(struct) 0xF0 + MusicData.dt 0x138 / showTick 0x14C
const SPINE_MUSIC_DATA = 0xF0, MD_DT = 0x138, MD_SHOW_TICK = 0x14C;

// StageBattleComponent.<offset>k__BackingField. 음악 위치 = (경과 + delay − offset) × 샘플레이트 (get_getMusicOffset 0x1D602BC).
const STAGE_OFFSET = 0xA8;

export function installOffset(): void {
    // info.txt offset (PC OffsetHookPatches). PC는 FixedOffset/FixedMusicOffset **Postfix**에서 offset을 덮는다:
    // 즉 그 판의 음악 시작 예약(GameStart: Delay(−delay + offset))과 첫 위치 맞춤(timeSamples)은 게임 설정의 사용자 보정값을 그대로 쓰고,
    // info.txt offset은 그 뒤(일시정지 해제 등)에만 쓰인다. 같은 순서로 해야 PC에서 맞춘 delay가 같은 뜻이 된다.
    // (처음 이식본은 FixedMusicOffset **진입**에서 덮어 첫 위치 맞춤부터 바뀌었다.)
    const Stage = gameClass("FormulaBase.StageBattleComponent");
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

export function installNoteSync(): void {
    // 프레임 드랍 뒤 늦게 스폰된 Spine 노트가 오른쪽에 뒤처지는 문제: "in" 재생 직후 시간을 now - showTick으로 당긴다 (PC NoteAnimationSyncPatch).
    const Spine = gameClass("SpineActionController");
    const Stage = gameClass("FormulaBase.StageBattleComponent");
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
