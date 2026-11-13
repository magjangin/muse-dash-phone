// 커스텀 곡 오디오 클립 (미리듣기·본곡). PC 9ee7036(곡 선택 휠 렉)과 같은 문제를 안드로이드에서 고친 것.
//
// 2026-11-13 실측 (mod.log frame-hitch, 곡 7MB OGG 기준):
//   예전 미리듣기 = RuntimeAudioClipLoader.Manager.Load(path, doStream:false, loadInBackground:true, useCache:true).
//   ① 곡을 넘길 때 Load가 메인 스레드를 100~150 ms 막았다. 대부분이 "곡 길이" 구하기다: CustomAudioFileReader..ctor가
//      readerStream.get_Length를 부르고, VorbisWaveReader는 그걸 PacketReader.ReadAllPages(OGG 전 페이지 읽기)로 구한다.
//      스트리밍으로 만들어도 Unity가 Create 중에 위치 0으로 시크하는데, VorbisWaveReader.set_Position이 범위 확인에
//      Length를 불러 똑같이 전부 훑는다(첫 시크 76~93 ms, 두 번째부터 0 ms). AudioClip.Create의 PCM 버퍼는 큰 몫이 아니었다.
//   ② 백그라운드 디코드가 끝나면 Manager.Update의 SetData가 또 10~72 ms 멈췄다.
//   ③ useCache 때문에 넘겨 본 곡마다 PCM(수십 MB)이 프로세스가 끝날 때까지 남았다.
//
// 지금:
//   미리듣기 = Manager.Load의 스트리밍 분기를 직접 조립한다. CustomAudioFileReader는 생성자를 부르지 않고 필드를 채운다
//     (length = 파일 끝 Ogg 페이지 granule). 곡 목록에 처음 들어오면 곡마다 리더를 열어 ReadAllPages를 관리 스레드에서
//     돌려 두고(warm-up, 곡당 약 100 ms, 메인 스레드는 리더 열기 약 7 ms만), 곡을 고르면 훑어 둔 리더로 클립만 만든다(7~8 ms).
//   본곡 = 정확한 timeSamples 시크가 필요해 전체 디코드 클립(싱크 보정이 이걸 전제로 맞춰져 있음).
//     준비 화면(PnlPreparation.OnEnable)에 들어오면 Manager의 백그라운드 디코드 큐에 직접 넣는다(길이 스캔 없음, 약 130 ms
//     = 대부분 Create의 PCM 버퍼. Manager.Load(path)로는 259 ms). 휠을 돌리는 동안엔 아무것도 풀지 않는다.
//     다 안 풀렸으면 예전처럼 동기로 푼다. 전체 디코드 클립은 한 곡 것만 든다.
//
// 파일 나눔(2026-11-13): ogg.ts(길이 읽기), clips.ts(클립 조립 부품), 여기(미리 훑기·미리듣기·본곡 정책).
import { log } from "../log.js";
import { onFrame } from "../frame.js";
import { perfMark } from "../perf.js";
import type { HwaSong } from "../hwa/library.js";
import { oggTotalSamples } from "./ogg.js";
import { AUDIO_LOADED, AUDIO_LOADING, createAudioApi } from "./clips.js";

export interface CustomAudio {
    /** 곡 목록에 들어왔을 때: 모든 곡의 미리듣기 리더를 백그라운드로 미리 훑는다(한 번만). */
    warmAll(songs: HwaSong[]): void;
    preview(song: HwaSong): Il2Cpp.Object | null;
    music(song: HwaSong): Il2Cpp.Object | null;
}

export function installCustomAudio(): CustomAudio {
    const { manager, destroy, pin, unpin, isAlive, keepNative, fullDecode, state, openVorbis, packetReaderOf, streamingClip, backgroundDecode,
        threadClass, threadStartClass, threadStartCtor, readAllPages, preparation } = createAudioApi();

    // 미리 훑기(warm-up): 곡 목록 커버를 처음 그릴 때 곡마다 리더를 열고(메인 스레드, 프레임당 하나),
    // ReadAllPages를 관리 스레드에서 돌린다. 미리듣기를 고를 땐 다 훑은 리더로 클립만 만든다.
    // 아직 훑는 중인 곡은 그 리더를 건드리지 않고(스레드가 같은 스트림을 읽는 중) 새 리더를 열어 메인 스레드에서 훑는다(예전 비용).
    type Warm = { song: HwaSong; samples: number; vorbis: Il2Cpp.Object; thread: Il2Cpp.Object; started: number; done: boolean };
    const warm = new Map<string, Warm>();
    const warmQueue: HwaSong[] = [];
    let warmRunning: Warm | null = null;
    let warmStartedAll = false;
    const keep: Il2Cpp.GCHandle[] = [];
    const startWarm = (song: HwaSong): void => {
        const samples = song.musicPath ? oggTotalSamples(song.musicPath) : -1;
        if (samples <= 0) return;   // granule을 못 읽는 파일은 미리듣기 때 Manager 경로로
        const vorbis = openVorbis(song.musicPath!);
        const packets = packetReaderOf(vorbis);
        const start = threadStartClass.alloc();
        threadStartCtor(start.handle, packets.handle, readAllPages.handle, NULL);
        const thread = threadClass.alloc();
        thread.method(".ctor").overload("System.Threading.ThreadStart").invoke(start);
        thread.method("set_IsBackground", 1).invoke(true);
        for (const o of [vorbis, thread]) keep.push(o.ref(true));
        thread.method("Start", 0).invoke();
        warmRunning = { song, samples, vorbis, thread, started: Date.now(), done: false };
        warm.set(song.virtualUid, warmRunning);
    };
    onFrame("preview-warm", () => {
        if (warmRunning) {
            if (warmRunning.thread.method<boolean>("get_IsAlive").invoke()) return;
            warmRunning.done = true;
            log({ t: "preview-warm", uid: warmRunning.song.virtualUid, ms: Date.now() - warmRunning.started });
            warmRunning = null;
        }
        const next = warmQueue.shift();
        if (next && !previews.has(next.virtualUid) && !warm.has(next.virtualUid)) startWarm(next);
    });
    const warmAll = (songs: HwaSong[]) => {
        if (warmStartedAll) return;
        warmStartedAll = true;
        warmQueue.push(...songs);
    };

    const previews = new Map<string, Il2Cpp.Object>();
    let full: { uid: string; clip: Il2Cpp.Object; background: boolean } | null = null;
    const retired: Il2Cpp.Object[] = [];
    let lastPreview: HwaSong | null = null;

    // 밀려난 전체 디코드 클립은 백그라운드 디코드가 끝난 뒤에만 지운다(풀리는 중에 지우면 Manager.Update가 지워진 클립에 SetData).
    const setFull = (next: NonNullable<typeof full>) => {
        if (full && !full.clip.handle.equals(next.clip.handle)) retired.push(full.clip);
        full = next;
    };
    let nextSweep = 0;
    onFrame("custom-audio", () => {
        if (retired.length === 0) return;
        const now = Date.now();
        if (now < nextSweep) return;
        nextSweep = now + 1000;
        for (let i = retired.length - 1; i >= 0; i--) {
            if (state(retired[i]) === AUDIO_LOADING) continue;
            const clip = retired.splice(i, 1)[0];
            destroy.invoke(clip);
            unpin(clip);
        }
    });

    const predecode = (song: HwaSong, why: string) => {
        if ((full?.uid === song.virtualUid && isAlive(full.clip)) || !song.musicPath) return;
        const started = Date.now();
        let how = "direct";
        let clip: Il2Cpp.Object | null = null;
        try {
            clip = backgroundDecode(song.musicPath, `hwa_music_${song.virtualUid}`);
        } catch (e) {
            log({ t: "predecode-direct-error", uid: song.virtualUid, error: `${e}` });
        }
        if (!clip) { how = "manager"; clip = fullDecode(song.musicPath, true); }
        if (!clip) { log({ t: "predecode-fail", uid: song.virtualUid }); return; }
        setFull({ uid: song.virtualUid, clip, background: true });
        const ms = Date.now() - started;
        perfMark(`predecode:${ms}`);
        log({ t: "predecode-start", uid: song.virtualUid, why, how, ms });
    };
    if (preparation) {
        Interceptor.attach(preparation.method("OnEnable", 0).virtualAddress, {
            onLeave() {
                try {
                    if (lastPreview) predecode(lastPreview, "preparation");
                } catch (e) {
                    log({ t: "predecode-error", error: `${e}` });
                }
            }
        });
    }

    return {
        warmAll,
        preview(song) {
            lastPreview = song;
            let clip = previews.get(song.virtualUid) ?? null;
            if (isAlive(clip)) return clip;
            if (clip) previews.delete(song.virtualUid);
            const started = Date.now();
            let how = "cold";
            try {
                const w = warm.get(song.virtualUid);
                if (w?.done) {
                    how = "warm";
                    clip = streamingClip(w.vorbis, w.samples, `hwa_preview_${song.virtualUid}`);
                } else {
                    // 큐에서 빼고(이미 훑는 중이면 그 스레드는 그대로 두고) 새 리더를 열어 여기서 훑는다.
                    const i = warmQueue.indexOf(song);
                    if (i >= 0) warmQueue.splice(i, 1);
                    const samples = oggTotalSamples(song.musicPath!);
                    if (samples > 0) clip = streamingClip(openVorbis(song.musicPath!), samples, `hwa_preview_${song.virtualUid}`);
                }
            } catch (e) {
                log({ t: "preview-stream-error", uid: song.virtualUid, how, error: `${e}` });
                clip = null;
            }
            if (!clip) {   // granule을 못 읽는 등: Manager 스트리밍(길이 스캔 포함)으로
                how = "manager-stream";
                const c = manager.method<Il2Cpp.Object>("Load", 4).invoke(Il2Cpp.string(song.musicPath!), true, false, false);
                clip = c && !c.isNull() ? pin(c) : null;
            }
            if (!clip) return null;
            // 씬 전환(UISystem ↔ GameMain) 때 Resources.UnloadUnusedAssets가 미리듣기 AudioClip을 지우지 않도록 막는다.
            keepNative(clip);
            previews.set(song.virtualUid, clip);
            const ms = Date.now() - started;
            perfMark(`preview-${how}:${ms}`);
            log({ t: "asset-made", key: `hwa_demo_${song.virtualUid}`, kind: "demo", how, ms, length: clip.method<number>("get_length").invoke() });
            return clip;
        },
        music(song) {
            if (full?.uid === song.virtualUid && isAlive(full.clip)) {
                const ready = !full.background || state(full.clip) === AUDIO_LOADED;
                log({ t: "music-from-predecode", uid: song.virtualUid, ready });
                if (ready) return full.clip;
            }
            const started = Date.now();
            const clip = fullDecode(song.musicPath!, false);
            if (!clip) return null;
            setFull({ uid: song.virtualUid, clip, background: false });
            log({ t: "asset-made", key: `hwa_music_${song.virtualUid}`, kind: "music", ms: Date.now() - started });
            return clip;
        }
    };
}
