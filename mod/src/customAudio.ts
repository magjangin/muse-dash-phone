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
import { log } from "./log.js";
import { onFrame } from "./frame.js";
import { perfMark } from "./perf.js";
import { regularFileSize } from "./native.js";
import type { HwaSong } from "./hwa/library.js";

const AUDIO_LOADING = 1;
const AUDIO_LOADED = 2;
const OGG_TAIL_BYTES = 65536;

function findClass(name: string): Il2Cpp.Class | null {
    for (const a of Il2Cpp.domain.assemblies) {
        const k = a.image.tryClass(name);
        if (k) return k;
    }
    return null;
}

/** OGG 파일의 마지막 페이지 granule = 채널당 총 샘플 수. 못 읽으면 -1. */
export function oggTotalSamples(path: string): number {
    const size = regularFileSize(path);
    if (size < 64) return -1;
    const from = Math.max(0, size - OGG_TAIL_BYTES);
    const f = new File(path, "rb");
    let tail: Uint8Array;
    try {
        f.seek(from, File.SEEK_SET);   // SEEK_CUR는 Frida 17.24.3에서 버퍼 위치 기준으로 어긋난다(AGENTS Dead End)
        tail = new Uint8Array(f.readBytes(size - from));
    } finally {
        f.close();
    }
    // 뒤에서부터 "OggS" + version 0 인 페이지 머리를 찾는다. 페이지 길이가 파일 끝을 넘지 않아야 진짜 머리로 본다.
    for (let i = tail.length - 27; i >= 0; i--) {
        if (tail[i] !== 0x4f || tail[i + 1] !== 0x67 || tail[i + 2] !== 0x67 || tail[i + 3] !== 0x53 || tail[i + 4] !== 0) continue;
        const segments = tail[i + 26];
        if (i + 27 + segments > tail.length) continue;
        let body = 0;
        for (let k = 0; k < segments; k++) body += tail[i + 27 + k];
        if (i + 27 + segments + body > tail.length) continue;
        let granule = 0;
        for (let k = 7; k >= 0; k--) granule = granule * 256 + tail[i + 6 + k];
        if (granule <= 0 || granule > 0x7fffffff) continue;   // -1(완성 패킷 없음)·비정상은 그 앞 페이지로
        return granule;
    }
    return -1;
}

export interface CustomAudio {
    /** 곡 목록에 들어왔을 때: 모든 곡의 미리듣기 리더를 백그라운드로 미리 훑는다(한 번만). */
    warmAll(songs: HwaSong[]): void;
    preview(song: HwaSong): Il2Cpp.Object | null;
    music(song: HwaSong): Il2Cpp.Object | null;
}

export function installCustomAudio(): CustomAudio {
    const manager = findClass("RuntimeAudioClipLoader.Manager")!;
    const readerClass = findClass("RuntimeAudioClipLoader.CustomAudioFileReader")!;
    const display = manager.nestedClasses.find(c => c.name === "<>c__DisplayClass12_0")!;
    const readCallback = display.method("<Load>b__0", 1);
    const seekCallback = display.method("<Load>b__1", 1);
    const clipClass = Il2Cpp.domain.assembly("UnityEngine.AudioModule").image.class("UnityEngine.AudioClip");
    const pcmReader = clipClass.nestedClasses.find(c => c.name === "PCMReaderCallback")!;
    const pcmSeek = clipClass.nestedClasses.find(c => c.name === "PCMSetPositionCallback")!;
    const delegateCtor = (k: Il2Cpp.Class) =>
        new NativeFunction(k.method(".ctor", 2).virtualAddress, "void", ["pointer", "pointer", "pointer", "pointer"]);
    const readerCtor = delegateCtor(pcmReader);
    const seekCtor = delegateCtor(pcmSeek);
    // 7인자 Create는 두 개(_3D판 포함)라 형으로 고른다. Manager.Load가 부르는 것과 같은 판(디스어셈블 0x433BEA4).
    const createStream = clipClass.method<Il2Cpp.Object>("Create").overload("System.String", "System.Int32", "System.Int32", "System.Int32",
        "System.Boolean", "UnityEngine.AudioClip.PCMReaderCallback", "UnityEngine.AudioClip.PCMSetPositionCallback");
    const vorbisClass = findClass("NVorbis.NAudioSupport.VorbisWaveReader")!;
    const sampleChannelClass = findClass("NAudio.Wave.SampleProviders.SampleChannel")!;
    const waveStreamCtor = new NativeFunction(findClass("NAudio.Wave.WaveStream")!.method(".ctor", 0).virtualAddress, "void", ["pointer", "pointer"]);
    const destroy = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Object").method("Destroy", 1);

    const pins = new Map<string, Il2Cpp.GCHandle>();
    const pin = (o: Il2Cpp.Object) => { pins.set(o.handle.toString(), o.ref(true)); return o; };
    const unpin = (o: Il2Cpp.Object) => { pins.get(o.handle.toString())?.free(); pins.delete(o.handle.toString()); };

    // useCache는 늘 false: Manager 캐시는 경로만 키로 써서 스트리밍 클립과 전체 디코드 클립을 구분하지 못하고, 지울 수도 없다.
    const fullDecode = (path: string, background: boolean): Il2Cpp.Object | null => {
        const clip = manager.method<Il2Cpp.Object>("Load", 4).invoke(Il2Cpp.string(path), false, background, false);
        return clip && !clip.isNull() ? pin(clip) : null;
    };
    // enum 반환값은 bridge가 숫자가 아니라 ValueType으로 준다 → value__ 를 읽는다.
    const state = (clip: Il2Cpp.Object): number => {
        const v = manager.method<Il2Cpp.ValueType>("GetAudioClipLoadState", 1).invoke(clip);
        return v ? v.field<number>("value__").value : -1;
    };

    const corlib = Il2Cpp.corlib;
    const fileStreamClass = corlib.class("System.IO.FileStream");
    const enumValue = (cls: string, name: string) => corlib.class(cls).field<Il2Cpp.ValueType>(name).value;
    const threadClass = corlib.class("System.Threading.Thread");
    const threadStartClass = corlib.class("System.Threading.ThreadStart");
    const threadStartCtor = delegateCtor(threadStartClass);
    const decoderClass = findClass("NVorbis.VorbisStreamDecoder")!;
    const readAllPages = findClass("NVorbis.Ogg.PacketReader")!.method("ReadAllPages", 0);

    /** OGG를 열어 VorbisWaveReader를 만든다(헤더·코드북만 읽음, 약 7 ms). 큰 버퍼: NVorbis가 작은 읽기·시크를 반복한다. */
    const openVorbis = (path: string): Il2Cpp.Object => {
        const stream = fileStreamClass.alloc();
        stream.method(".ctor").overload("System.String", "System.IO.FileMode", "System.IO.FileAccess", "System.IO.FileShare", "System.Int32")
            .invoke(Il2Cpp.string(path), enumValue("System.IO.FileMode", "Open"), enumValue("System.IO.FileAccess", "Read"),
                enumValue("System.IO.FileShare", "Read"), 262144);
        const vorbis = vorbisClass.alloc();
        vorbis.method(".ctor").overload("System.IO.Stream").invoke(stream);
        return vorbis;
    };
    /** VorbisWaveReader → 첫 스트림 디코더의 PacketReader. */
    const packetReaderOf = (vorbis: Il2Cpp.Object): Il2Cpp.Object => {
        const reader = vorbis.field<Il2Cpp.Object>("_reader").value;
        const decoders = reader.field<Il2Cpp.Object>("_decoders").value;
        const decoder = decoders.method<Il2Cpp.Object>("get_Item", 1).invoke(0);
        return new Il2Cpp.Object(decoder.handle.add(decoderClass.field("_packetProvider").offset).readPointer());
    };

    /** Manager.Load(Stream, …, doStream:true)와 같은 클립을 만든다. CustomAudioFileReader..ctor(0x1C8D4F8)를 그대로 따라 하되
     *  readerStream.get_Length(전체 페이지 스캔)만 granule로 대신한다. */
    const buildReader = (vorbis: Il2Cpp.Object, samples: number) => {
        const reader = readerClass.alloc();
        waveStreamCtor(reader.handle, NULL);   // base(): Stream 쪽 필드 초기화
        const lock = corlib.class("System.Object").alloc();
        lock.method(".ctor").invoke();
        reader.field<Il2Cpp.Object>("lockObject").value = lock;
        reader.field<Il2Cpp.Object>("readerStream").value = vorbis;
        const format = vorbis.method<Il2Cpp.Object>("get_WaveFormat").invoke();
        const channels = format.method<number>("get_Channels").invoke();
        const rate = format.method<number>("get_SampleRate").invoke();
        const bits = format.field<number>("bitsPerSample").value;
        const sampleChannel = sampleChannelClass.alloc();
        sampleChannel.method(".ctor", 2).invoke(vorbis, false);
        const destBytes = 4 * sampleChannel.method<Il2Cpp.Object>("get_WaveFormat").invoke().method<number>("get_Channels").invoke();
        reader.field<Il2Cpp.Object>("sampleChannel").value = sampleChannel;
        reader.field<number>("sourceBytesPerSample").value = (bits >> 3) * channels;
        reader.field<number>("destBytesPerSample").value = destBytes;
        // 원본: length = readerStream.Length / sourceBytes * destBytes. Vorbis Length = 채널당 총 샘플 × sourceBytes.
        reader.field<Int64>("length").value = int64(samples * destBytes);
        return { reader, channels, rate };
    };
    const streamingClip = (vorbis: Il2Cpp.Object, samples: number, name: string): Il2Cpp.Object | null => {
        const { reader, channels, rate } = buildReader(vorbis, samples);
        const target = display.alloc();
        target.method(".ctor").invoke();
        target.field<Il2Cpp.Object>("reader").value = reader;
        // 델리게이트 .ctor(object target, IntPtr method): method는 MethodInfo*. Load 디스어셈블처럼 (delegate, target, MethodInfo*, null)로
        // 직접 부른다(bridge invoke는 IntPtr 인자를 NativePointer로도 정수로도 받지 않았다).
        const onRead = pcmReader.alloc();
        readerCtor(onRead.handle, target.handle, readCallback.handle, NULL);
        const onSeek = pcmSeek.alloc();
        seekCtor(onSeek.handle, target.handle, seekCallback.handle, NULL);
        // Create는 콜백으로 첫 버퍼를 채우며 위치 0으로 시크한다. VorbisWaveReader.set_Position은 범위 확인에 Length를 부르고,
        // 그게 PacketReader.ReadAllPages로 파일 전체를 훑는다(첫 시크만 76~93 ms, 이후 0 ms) → 미리 훑어 둔 리더(warm)면 몇 ms.
        const clip = createStream.invoke(Il2Cpp.string(name), samples, channels, rate, true, onRead, onSeek);
        return clip && !clip.isNull() ? pin(clip) : null;
    };

    // 본곡 미리 풀기: Manager.Load(path, doStream:false, loadInBackground:true)의 백그라운드 분기(0x1C8F3E0~0x1C8F514)를
    // 그대로 따라 하되 리더는 길이 스캔 없이 만든다(Manager.Load(path)는 4KB 버퍼 스트림 + 길이 스캔으로 준비 화면 진입 때 259 ms).
    // 순서: Create(name, 채널당 샘플, ch, rate, stream:false) → AudioInstance{clip, reader, samplesCount} → 로드 타입 0·상태 Loading
    //   → lock(deferredLoadQueue) Enqueue → RunDeferredLoaderThread → EnsureInstanceExists. 디코드·SetData는 Manager가 한다.
    const audioInstance = manager.nestedClasses.find(c => c.name === "AudioInstance")!;
    const createPlain = clipClass.method<Il2Cpp.Object>("Create").overload("System.String", "System.Int32", "System.Int32", "System.Int32", "System.Boolean");
    const audioModule = Il2Cpp.domain.assembly("UnityEngine.AudioModule").image;
    const loadTypeDecompress = audioModule.class("UnityEngine.AudioClipLoadType").field<Il2Cpp.ValueType>("DecompressOnLoad").value;
    const loadStateLoading = audioModule.class("UnityEngine.AudioDataLoadState").field<Il2Cpp.ValueType>("Loading").value;
    const monitor = corlib.class("System.Threading.Monitor");
    const backgroundDecode = (path: string, name: string): Il2Cpp.Object | null => {
        const samples = oggTotalSamples(path);
        if (samples <= 0) return null;
        const { reader, channels, rate } = buildReader(openVorbis(path), samples);
        const clip = createPlain.invoke(Il2Cpp.string(name), samples, channels, rate, false);
        if (!clip || clip.isNull()) return null;
        const ai = audioInstance.alloc();
        ai.method(".ctor").invoke();
        ai.field<Il2Cpp.Object>("audioClip").value = clip;
        ai.field<Il2Cpp.Object>("reader").value = reader;
        ai.field<number>("samplesCount").value = samples * channels;
        manager.method("SetAudioClipLoadType", 2).invoke(clip, loadTypeDecompress);
        manager.method("SetAudioClipLoadState", 2).invoke(clip, loadStateLoading);
        const queue = manager.field<Il2Cpp.Object>("deferredLoadQueue").value;
        monitor.method("Enter", 1).invoke(queue);
        try {
            queue.method("Enqueue", 1).invoke(ai);
        } finally {
            monitor.method("Exit", 1).invoke(queue);
        }
        manager.method("RunDeferredLoaderThread", 0).invoke();
        manager.method("EnsureInstanceExists", 0).invoke();
        return pin(clip);
    };

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
        if (full?.uid === song.virtualUid || !song.musicPath) return;
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
    const preparation = Il2Cpp.domain.assembly("Assembly-CSharp").image.tryClass("PnlPreparation");
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
            if (clip) return clip;
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
            previews.set(song.virtualUid, clip);
            const ms = Date.now() - started;
            perfMark(`preview-${how}:${ms}`);
            log({ t: "asset-made", key: `hwa_demo_${song.virtualUid}`, kind: "demo", how, ms, length: clip.method<number>("get_length").invoke() });
            return clip;
        },
        music(song) {
            if (full?.uid === song.virtualUid) {
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
