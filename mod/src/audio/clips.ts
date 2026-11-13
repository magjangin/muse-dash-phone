// RuntimeAudioClipLoader 위에서 클립을 직접 조립하는 부품들 (customAudio.ts installCustomAudio 앞부분을 분리, 2026-11-13).
// 정책(미리 훑기·미리듣기·본곡 고르기)은 audio/index.ts에 있다. 실측 근거는 audio/index.ts 머리 주석.
import { findClass, gameImage } from "../il2cpp.js";
import { oggTotalSamples } from "./ogg.js";

export const AUDIO_LOADING = 1;
export const AUDIO_LOADED = 2;

export type AudioApi = ReturnType<typeof createAudioApi>;

export function createAudioApi() {
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
    const coreImage = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
    const unityObject = coreImage.class("UnityEngine.Object");
    const destroy = unityObject.method("Destroy", 1);
    const opImplicit = unityObject.method<boolean>("op_Implicit", 1);
    const dontUnload = coreImage.class("UnityEngine.HideFlags").field<Il2Cpp.ValueType>("DontUnloadUnusedAsset").value;

    const isAlive = (o: Il2Cpp.Object | null | undefined): o is Il2Cpp.Object => !!o && !o.isNull() && opImplicit.invoke(o);
    const keepNative = (o: Il2Cpp.Object): Il2Cpp.Object => {
        o.method("set_hideFlags", 1).invoke(dontUnload);
        return o;
    };

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

    const preparation = gameImage().tryClass("PnlPreparation");
    return {
        manager, destroy, pin, unpin, isAlive, keepNative, fullDecode, state, openVorbis, packetReaderOf, streamingClip, backgroundDecode,
        threadClass, threadStartClass, threadStartCtor, readAllPages, preparation
    };
}
