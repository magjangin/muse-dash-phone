// 1단계 커스텀 차트: 곡 폴더 info.txt의 '가져올 uid'(숙주 곡)를 플레이하면 그 곡의 차트·음악·delay를 곡 폴더 것으로 바꾼다.
// 커스텀 태그·가상 곡(1999-N)은 다음 단계. 근거: docs/custom_chart.md 2~6절.
import { guard, log } from "./log.js";
import { readIl2CppString } from "./native.js";
import { loadLibrary, reloadManifest, songForUid } from "./hwa/library.js";
import type { HwaSong } from "./hwa/library.js";
import { DB_STAGE_INFO_MUSIC_LIST, injectChart, readListSample } from "./chart/inject.js";
import { writeDecimal } from "./native.js";
import { startBga, stopBga } from "./bga.js";
import { applyAutoPlay, shouldAutoPlay } from "./autoplay.js";

const RVA = {
    SetRuntimeMusicData: 0x20D29D4,   // DBStageInfo.SetRuntimeMusicData(List<MusicData>) = this.musicList = data
    get_delay: 0x20D2860,             // DBStageInfo.get_delay → Decimal (x0:x1로 반환)
    LoadFromName: 0x1FDA3D4           // ResourcesManager.LoadFromName<T>(string) 공유 본체
};

let activeSong: HwaSong | null = null;
let serial = 0;          // SetRuntimeMusicData(=새 배틀·재시작)마다 1씩
export function battleSerial(): number { return serial; }
let audioLength = 0;      // 이번 배틀 커스텀 OGG 길이(초)

export function setBattleAudioLength(seconds: number): void { audioLength = seconds; }

/** 이번 배틀에 적용 중인 커스텀 곡 (SetRuntimeMusicData에서 정해짐). 노트마다 불리는 훅은 이걸 쓴다. */
export function battleSong(): HwaSong | null { return activeSong; }
/** 커스텀 곡의 실제 길이: OGG 길이와 마지막 노트 끝 중 큰 값 (PC ProgressBarPatch.GetEffectiveDuration). */
export function battleDuration(): number {
    const chartEnd = activeSong ? lastChartEnd : 0;
    return Math.max(audioLength, chartEnd);
}
let lastChartEnd = 0;

function findClass(name: string): Il2Cpp.Class | null {
    for (const a of Il2Cpp.domain.assemblies) {
        const k = a.image.tryClass(name);
        if (k) return k;
    }
    return null;
}

/** 지금 고른 곡이 커스텀 곡이면 그 곡 (배틀 전 단계 훅용). */
export function currentCustomSong(): HwaSong | null { return songForUid(currentMusicUid()); }

/** GlobalDataBase.s_DbBattleStage.m_MusicUid — 지금 고른 곡 uid(예 "0-4"). */
function currentMusicUid(): string | null {
    const gdb = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.Database.GlobalDataBase");
    const stage = gdb.field<Il2Cpp.Object>("s_DbBattleStage").value;
    if (!stage || stage.isNull()) return null;
    const uid = stage.field<Il2Cpp.String>("m_MusicUid").value;
    return uid && !uid.isNull() ? uid.content : null;
}

/** 숙주 uid의 실제 곡 이름(현재 언어). 게임 DB가 아직 안 만들어졌으면 null. */
function hostSongName(uid: string): string | null {
    const gdb = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.Database.GlobalDataBase");
    const tag = gdb.field<Il2Cpp.Object>("s_DbMusicTag").value;
    if (!tag || tag.isNull()) return null;
    const info = tag.method<Il2Cpp.Object>("GetMusicInfoFromAll").invoke(Il2Cpp.string(uid));
    if (!info || info.isNull()) return null;
    const local = info.method<Il2Cpp.Object>("GetLocal").invoke(0);
    const name = local && !local.isNull() ? local.field<Il2Cpp.String>("name").value : null;
    return name && !name.isNull() ? name.content : info.field<Il2Cpp.String>("name").value?.content ?? null;
}

export function installCustomChart(): void {
    const songs = loadLibrary();
    if (songs.length === 0) {
        log({ t: "custom-chart-idle", reason: "곡 폴더 없음" });
        return;
    }
    const base = Il2Cpp.module.base;
    const musicDataClass = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("GameLogic.MusicData");
    log({ t: "custom-chart-classes", musicDataSize: musicDataClass.valueTypeSize });

    Interceptor.attach(base.add(RVA.SetRuntimeMusicData), {
        onEnter(args) { (this as any).self = args[0]; },
        onLeave() {
            guard("chart-inject", () => {
                const uid = currentMusicUid();
                const song = songForUid(uid);
                activeSong = song;
                serial++;
                if (song) reloadManifest(song);   // info.txt를 판마다 다시 읽어 싱크 값을 재시작 없이 고칠 수 있게
                if (!song) {
                    stopBga();
                    applyAutoPlay(false);
                    return;
                }
                applyAutoPlay(shouldAutoPlay());
                if (song.videoPath && song.manifest.cinema !== false) {
                    startBga(song.videoPath);
                } else {
                    stopBga();
                }
                const list = ((this as any).self as NativePointer).add(DB_STAGE_INFO_MUSIC_LIST).readPointer();
                log({ t: "chart-target", uid, song: song.name, before: readListSample(list, 3, musicDataClass.valueTypeSize) });
                lastChartEnd = injectChart(list, song, musicDataClass);
                log({ t: "chart-after", sample: readListSample(list, 4, musicDataClass.valueTypeSize) });
            });
        }
    });

    // delay: get_delay는 StageInfo 에셋 값을 읽는다. 에셋을 고치면 숙주 곡에 남으니 반환값(x0:x1 = flags,hi | lo,mid)만 바꾼다.
    // 음악 시작 = −delay + offset 초 뒤, 위치 = 경과 + delay − offset (GameStart / get_getMusicOffset).
    // PC info.txt의 delay(neon −0.575)는 PC 모드의 스트리밍 BGM 경로(Load 때 Play, 시크가 스트림에 안 먹음)를 맞추려고 넣은 값이라,
    // 디코드한 클립을 정확히 시크하는 Android에선 그만큼 음악이 늦어진다(실측 음악 − 게임 시계 = −0.57초, logs/31_mod.log).
    // → Android는 'android delay' 키가 있으면 그 값, 없으면 0 (BMS 0초 = OGG 0초).
    const scratch = Memory.alloc(16);
    let delayLogged = false;
    let delayCalls = 0;
    Interceptor.attach(base.add(RVA.get_delay), {
        onLeave() {
            if (delayCalls++ < 5) log({ t: "delay-call", active: activeSong?.name ?? null, x0: (this.context as Arm64CpuContext).x0.toString(), x1: (this.context as Arm64CpuContext).x1.toString() });
            const d = activeSong ? (activeSong.manifest.androidDelay ?? 0) : null;
            if (activeSong === null || d === null || d === undefined) return;
            writeDecimal(scratch, d);
            const ctx = this.context as Arm64CpuContext;
            ctx.x0 = scratch.readPointer();
            ctx.x1 = scratch.add(8).readPointer();
            if (!delayLogged) { delayLogged = true; log({ t: "delay-override", song: activeSong.name, delay: d }); }
        }
    });

    // 음악·미리듣기·커버 교체는 customTag.ts(가상 곡 에셋 키)에서 한다.
    log({ t: "custom-chart-ready", songs: songs.map(s => `${s.name} → ${s.manifest.uid}`) });
    // 게임이 이미 돌고 있을 때(스크립트 재로드) 숙주 곡 이름을 남긴다. 처음 켤 땐 DB가 아직 없어 null.
    guard("host-names", () => {
        log({ t: "host-songs", hosts: songs.map(s => ({ song: s.name, uid: s.manifest.uid, host: s.manifest.uid ? hostSongName(s.manifest.uid) : null })) });
    });
}
