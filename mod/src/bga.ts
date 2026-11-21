// 안드로이드 네이티브 BGA 비디오 재생 (PC HwaBattleMediaController.Video.cs + HwaSyncManager 이식).
// Unity의 VideoModule이 스트리핑되어 있으므로, Android 네이티브 MediaPlayer + SurfaceView를
// UnityPlayerActivity 위에 반투명 SurfaceView로 겹쳐 재생합니다.
//
// 재생 시점·싱크 (PC 867f583·cae7fa9, 2026-11-21 반영):
//  - 배틀 준비(SetRuntimeMusicData)에서는 prepareAsync만 한다. 예전엔 준비되자마자 start()해서 음악보다 수 초 먼저 흘렀다.
//  - 게임이 음악을 시작한 뒤(FixedOffset) BGM이 실제로 돌면 bgm.time 위치로 시크하고 재생한다
//    (영상이 곡 오디오와 같은 타임라인으로 만들어졌기 때문에 게임 시계가 아니라 bgm.time 기준).
//  - 0.1초마다 오차를 재서 20ms 넘으면 재생 속도를 오차에 비례해 최대 ±15% 바꿔 따라붙고, 0.5초 넘을 때만 시크한다.
//    시작·시크 뒤 2초는 위치 값이 옛 값이라 보정·통계를 쉰다. 30초마다 평균/최대 오차를 남긴다.
//  - 승리 배너 때 끊지 않는다(곡 꼬리 3초 동안 계속). 정지는 End/Exit, 다른 곡 배틀 시작 때.
//  - 일시정지(BGM이 멈춤)면 영상도 멈추고, 다시 BGM이 돌면 그 위치에서 다시 시작한다.
//  - MediaPlayer 호출은 스크립트 스레드(setInterval)에서 한다. 게임 스레드는 bgm 시각만 적는다(syncTick 설명).
//  - 영상 소리는 지금처럼 끈다(곡은 OGG가 담당). PC는 사용자 결정으로 영상 소리를 켜 두었다.
import Java from "frida-java-bridge";
import { log } from "./log.js";
import { battleSerial, battleSong } from "./customChart.js";
import { onFrame } from "./frame.js";
import { gameClass } from "./il2cpp.js";
import { nowUs } from "./native.js";
import { perfMark } from "./perf.js";

const SYNC_INTERVAL_MS = 100;
const SEEK_COOLDOWN_MS = 2000;
const SEEK_THRESHOLD = 0.5;
const SPEED_DEADBAND = 0.02;
const SPEED_GAIN = 1.0;          // 오차 0.1초 → 속도 ±10%
const MAX_SPEED_DELTA = 0.15;
const REPORT_MS = 30000;
const SEEK_CLOSEST = 3;          // MediaPlayer.SEEK_CLOSEST (API 26)
const BGA_ALPHA = 0.5;           // 영상이 게임 위에 겹치므로 노트가 보이게 반투명

/**
 * BGA 재생 스위치. 2026-11-21 사용자 결정으로 **꺼 둔다**: 게임 위 반투명 오버레이는 노트를 가려 PC(배경 쿼드)와 너무 다르다.
 * 배경으로 깔 수 있는지는 bgaProbe.ts가 배틀 진입 때 진단 로그로 모은다. 재생 코드는 그대로 두고 여기서만 막는다.
 */
const BGA_PLAYBACK = false;
let disabledLogged = false;

let isPlaying = false;           // 뷰·플레이어가 붙어 있는지
let player: any = null;          // android.media.MediaPlayer
let view: any = null;
let root: any = null;
let prepared = false;
let durationS = 0;
let playingVideo = false;        // start() 상태
let currentSpeed = 1;
let bgaSerial = -1;              // 이 영상이 속한 배틀
let musicStartedSerial = -1;     // 게임이 음악을 시작한 배틀 (FixedOffset)
let cooldownUntil = 0;
let pauseSerial = -1;            // 일시정지로 멈춘 배틀
const stats = { samples: 0, sumAbs: 0, maxAbs: 0, seeks: 0, since: 0, costMax: 0, costSum: 0, costN: 0 };

function resetStats(now: number): void {
    stats.samples = 0; stats.sumAbs = 0; stats.maxAbs = 0; stats.seeks = 0; stats.since = now; stats.costMax = 0; stats.costSum = 0; stats.costN = 0;
}

export function startBga(mp4Path: string): void {
    if (isPlaying) stopBga();
    if (!mp4Path) return;
    if (!BGA_PLAYBACK) {
        if (!disabledLogged) { disabledLogged = true; log({ t: "bga-disabled", path: mp4Path }); }
        return;
    }
    if (!Java.available) { log({ t: "bga-error", error: "Java not available" }); return; }

    try {
        Java.performNow(() => {
            const UnityPlayer = Java.use("com.unity3d.player.UnityPlayer");
            const activity = UnityPlayer.currentActivity.value;
            if (!activity) {
                log({ t: "bga-error", error: "UnityPlayer.currentActivity is null" });
                return;
            }

            const File = Java.use("java.io.File");
            if (!File.$new(mp4Path).exists()) {
                log({ t: "bga-file-not-found", path: mp4Path });
                return;
            }

            const MediaPlayer = Java.use("android.media.MediaPlayer");
            const mp = MediaPlayer.$new();
            mp.setDataSource(mp4Path);
            mp.setLooping(true);
            mp.setVolume(0.0, 0.0); // 오디오는 BGM OGG가 담당하므로 음소거

            const Runnable = Java.use("java.lang.Runnable");
            const SurfaceView = Java.use("android.view.SurfaceView");
            const SurfaceHolderCallback = Java.use("android.view.SurfaceHolder$Callback");
            const FrameLayout = Java.use("android.widget.FrameLayout");
            const LayoutParams = Java.use("android.widget.FrameLayout$LayoutParams");
            const OnPreparedListener = Java.use("android.media.MediaPlayer$OnPreparedListener");
            const stamp = Date.now();
            const serial = battleSerial();

            const prepListener = Java.registerClass({
                name: "com.prpr.musedash.mod.BgaPrepListener_" + stamp,
                implements: [OnPreparedListener],
                methods: {
                    onPrepared(p: any) {
                        // 여기서 start()하지 않는다. 음악이 시작되면 프레임 훅이 bgm 위치에서 튼다.
                        if (player === null || bgaSerial !== serial) return;
                        prepared = true;
                        durationS = p.getDuration() / 1000;
                        log({ t: "bga-prepared", path: mp4Path, duration: durationS });
                    }
                }
            });
            mp.setOnPreparedListener(prepListener.$new());

            // TextureView는 하드웨어 가속 창에서만 그려진다. Unity 창은 가속이 꺼져 있어
            // "A TextureView or a subclass can only be used with hardware acceleration enabled"로 표면이 안 생겼다(2026-11-21 실기).
            // → SurfaceView. Unity 화면도 SurfaceView라 그 위에 보이려면 setZOrderMediaOverlay(true)로 올린다.
            let prepareRequested = false;
            const holderCallback = Java.registerClass({
                name: "com.prpr.musedash.mod.BgaHolderCallback_" + stamp,
                implements: [SurfaceHolderCallback],
                methods: {
                    surfaceCreated(holder: any) {
                        try {
                            mp.setDisplay(holder);
                            if (!prepareRequested) { prepareRequested = true; mp.prepareAsync(); }
                            applyLayerAlpha("created");
                            log({ t: "bga-surface-created" });
                        } catch (e) {
                            log({ t: "bga-surface-error", error: `${e}` });
                        }
                    },
                    surfaceChanged(holder: any, format: number, width: number, height: number) { applyLayerAlpha("changed"); },
                    surfaceDestroyed(holder: any) {
                        try { mp.setDisplay(null); } catch (e) { /* 이미 풀림 */ }
                    }
                }
            });

            const setupRunnable = Java.registerClass({
                name: "com.prpr.musedash.mod.BgaSetupRunnable_" + stamp,
                implements: [Runnable],
                methods: {
                    run() {
                        try {
                            const surfaceView = SurfaceView.$new(activity);
                            surfaceView.setZOrderMediaOverlay(true);
                            surfaceView.setAlpha(BGA_ALPHA);
                            surfaceView.getHolder().addCallback(holderCallback.$new());
                            const lp = LayoutParams.$new(LayoutParams.MATCH_PARENT.value, LayoutParams.MATCH_PARENT.value);
                            const content = Java.cast(activity.findViewById(16908290), FrameLayout); // android.R.id.content
                            content.addView(surfaceView, lp);
                            view = surfaceView;
                            root = content;
                            log({ t: "bga-view-added", children: content.getChildCount(), alpha: BGA_ALPHA });
                        } catch (e) {
                            log({ t: "bga-ui-error", error: `${e}` });
                        }
                    }
                }
            });

            player = mp;
            isPlaying = true;
            prepared = false;
            playingVideo = false;
            currentSpeed = 1;
            durationS = 0;
            bgaSerial = serial;
            pauseSerial = -1;
            activity.runOnUiThread(setupRunnable.$new());
            log({ t: "bga-setup", path: mp4Path, serial });
        });
    } catch (e) {
        log({ t: "bga-init-error", error: `${e}` });
    }
}

export function stopBga(why = "stop"): void {
    if (!isPlaying) return;
    isPlaying = false;
    prepared = false;
    playingVideo = false;
    const mp = player, v = view, r = root;
    player = null; view = null; root = null;

    // stop/release는 미디어 서버 binder 호출이라 몇 ms 걸릴 수 있다. End·Exit 훅(게임 스레드)에서 바로 부르지 않고
    // 스크립트 스레드로 넘긴다.
    setTimeout(() => {
        try {
            Java.performNow(() => {
                if (mp) {
                    try { mp.stop(); } catch (e) { /* 준비 전이면 IllegalState */ }
                    try { mp.release(); } catch (e) { /* 이미 풀림 */ }
                }
                if (v && r) {
                    const activity = Java.use("com.unity3d.player.UnityPlayer").currentActivity.value;
                    if (activity) {
                        const Runnable = Java.use("java.lang.Runnable");
                        const cleanupRunnable = Java.registerClass({
                            name: "com.prpr.musedash.mod.BgaCleanupRunnable_" + Date.now(),
                            implements: [Runnable],
                            methods: {
                                run() {
                                    try { r.removeView(v); } catch (e) { /* 이미 빠짐 */ }
                                }
                            }
                        });
                        activity.runOnUiThread(cleanupRunnable.$new());
                    }
                }
            });
            log({ t: "bga-stopped", why });
        } catch (e) {
            log({ t: "bga-stop-error", error: `${e}` });
        }
    }, 0);
}

function setSpeed(speed: number): void {
    // setPlaybackParams는 멈춘 플레이어를 재생시키므로 재생 중일 때만 부른다.
    const params = player.getPlaybackParams();
    player.setPlaybackParams(params.setSpeed(speed));
    currentSpeed = speed;
}

/**
 * SurfaceView는 View.setAlpha가 화면에 안 먹었다(2026-11-21 실기: 영상이 게임을 완전히 덮음, 하드웨어 가속이 꺼진 창).
 * 그래서 SurfaceFlinger 레이어 알파를 SurfaceControl.Transaction으로 직접 준다(API 29+).
 */
let alphaLogs = 0;
function applyLayerAlpha(where: string): void {
    const sv = view;
    if (!sv) return;
    try {
        const sc = sv.getSurfaceControl();
        if (!sc) return;
        const tx = Java.use("android.view.SurfaceControl$Transaction").$new();
        tx.setAlpha(sc, BGA_ALPHA);
        tx.apply();
        if (alphaLogs++ < 4) log({ t: "bga-layer-alpha", where, alpha: BGA_ALPHA });
    } catch (e) {
        if (alphaLogs++ < 4) log({ t: "bga-layer-alpha-error", where, error: `${e}` });
    }
}

function expectedVideoTime(master: number): number {
    return durationS > 0.5 ? master % durationS : master;
}

/** 게임 스레드가 남기는 BGM 상태 (스크립트 스레드는 IL2CPP를 부르지 않는다, index.ts "free" 설계). */
const snap = { serial: -1, master: 0, atUs: 0, playing: false };
const STALE_US = 300_000;        // 게임 프레임이 이만큼 안 오면(백그라운드·화면 꺼짐) 멈춘 것으로 본다
let frameCostMax = 0;

/**
 * 스크립트 스레드에서 0.1초마다: 영상 시작·일시정지·오차 보정.
 * MediaPlayer 호출은 미디어 서버 binder 호출이라 게임 스레드(프레임 훅)에서 하면 평균 2.6 ms, 최대 20 ms가 걸렸다
 * (2026-11-21 il vento d'oro 첫 판 bga-drift costAvgUs/costMaxUs). 그래서 게임 스레드는 bgm 시각만 적고, 여기서 외삽해 쓴다.
 */
function syncTick(): void {
    const mp = player;
    if (!isPlaying || !prepared || mp === null) return;
    if (snap.serial !== bgaSerial || musicStartedSerial !== bgaSerial) return;
    const t0 = nowUs();
    const now = Date.now();
    const fresh = t0 - snap.atUs < STALE_US;
    const playing = snap.playing && fresh;

    Java.performNow(() => {
        if (player !== mp) return;                           // 그 사이 stopBga
        if (!playing) {
            if (playingVideo) {
                mp.pause();
                playingVideo = false;
                pauseSerial = bgaSerial;
                log({ t: "bga-paused", fresh });
            }
            return;
        }
        const master = snap.master + (t0 - snap.atUs) / 1e6;
        if (!playingVideo) {
            // 시작(또는 일시정지 뒤 다시 시작): bgm 위치로 시크하고 재생
            const start = expectedVideoTime(master);
            if (start > 0.05) mp.seekTo(Math.round(start * 1000), SEEK_CLOSEST);
            mp.start();
            if (currentSpeed !== 1) setSpeed(1);
            playingVideo = true;
            applyLayerAlpha("start");
            cooldownUntil = now + SEEK_COOLDOWN_MS;
            resetStats(now);
            log({ t: pauseSerial === bgaSerial ? "bga-resumed" : "bga-started", bgmTime: master, videoTime: start });
            return;
        }
        const expected = expectedVideoTime(master);
        const current = mp.getCurrentPosition() / 1000;
        let diff = current - expected;                       // + : 영상이 앞섬
        if (durationS > 0.5) {
            if (diff > durationS / 2) diff -= durationS;
            else if (diff < -durationS / 2) diff += durationS;
        }
        if (now < cooldownUntil) return;                     // 시크 직후엔 위치가 옛 값
        const abs = Math.abs(diff);
        stats.samples++; stats.sumAbs += abs; if (abs > stats.maxAbs) stats.maxAbs = abs;

        if (abs > SEEK_THRESHOLD) {
            log({ t: "bga-seek", diff: Math.round(diff * 1000) / 1000, video: current, bgm: expected });
            if (currentSpeed !== 1) setSpeed(1);
            mp.seekTo(Math.round(expected * 1000), SEEK_CLOSEST);
            cooldownUntil = now + SEEK_COOLDOWN_MS;
            stats.seeks++;
            return;
        }
        const target = abs <= SPEED_DEADBAND ? 1 : 1 - Math.min(MAX_SPEED_DELTA, Math.max(-MAX_SPEED_DELTA, diff * SPEED_GAIN));
        if (Math.abs(currentSpeed - target) > 0.005) setSpeed(target);
    });

    const us = nowUs() - t0;
    if (us > stats.costMax) stats.costMax = us;
    stats.costSum += us; stats.costN++;
    if (stats.since && now - stats.since >= REPORT_MS && stats.samples > 0) {
        log({ t: "bga-drift", seconds: Math.round((now - stats.since) / 1000), avgMs: Math.round(stats.sumAbs / stats.samples * 1000),
            maxMs: Math.round(stats.maxAbs * 1000), seeks: stats.seeks, speed: currentSpeed,
            scriptAvgUs: stats.costN ? Math.round(stats.costSum / stats.costN) : 0, scriptMaxUs: stats.costMax, frameMaxUs: frameCostMax });
        frameCostMax = 0;
        resetStats(now);
    }
}

export function installBga(): void {
    const Stage = gameClass("FormulaBase.StageBattleComponent");
    const AudioManager = gameClass("Assets.Scripts.PeroTools.Managers.AudioManager");
    let src: NativePointer | null = null;
    let srcSerial = -1;
    let getTime: NativeFunction<number, [NativePointerValue, NativePointerValue]> | null = null;
    let getIsPlaying: NativeFunction<number, [NativePointerValue, NativePointerValue]> | null = null;
    let bgmFailLogged = false;

    /** 게임 BGM AudioSource (Singleton<AudioManager>.instance.bgm). 배틀마다 한 번 찾는다. */
    const bgm = (): NativePointer | null => {
        if (srcSerial === battleSerial() && src !== null) return src;
        try {
            const am = AudioManager.method<Il2Cpp.Object>("get_instance").invoke();
            const s = am?.method<Il2Cpp.Object>("get_bgm").invoke();
            if (!s || s.isNull()) return null;
            if (getTime === null) {
                getTime = new NativeFunction(s.method("get_time", 0).virtualAddress, "float", ["pointer", "pointer"]);
                getIsPlaying = new NativeFunction(s.method("get_isPlaying", 0).virtualAddress, "uint8", ["pointer", "pointer"]);
            }
            src = s.handle;
            srcSerial = battleSerial();
            return src;
        } catch (e) {
            if (!bgmFailLogged) { bgmFailLogged = true; log({ t: "bga-bgm-error", error: `${e}` }); }
            return null;
        }
    };

    Interceptor.attach(Stage.method("FixedOffset").virtualAddress, {
        onLeave() {
            if (!battleSong()) return;
            musicStartedSerial = battleSerial();
        }
    });
    // 끝·나가기에서만 멈춘다 (승리 배너에선 계속, PC b0cf0af). 일시정지는 bgm이 멈춘 것으로 syncTick이 알아챈다.
    Interceptor.attach(Stage.method("End").virtualAddress, { onEnter() { stopBga("end"); } });
    Interceptor.attach(Stage.method("Exit", 3).virtualAddress, { onEnter() { stopBga("exit"); } });

    // 게임 스레드: bgm 시각만 적는다 (NativeFunction 두 번)
    onFrame("bga", () => {
        if (!isPlaying || !prepared) return;
        const serial = battleSerial();
        if (bgaSerial !== serial || musicStartedSerial !== serial) return;
        const t0 = nowUs();
        const s = bgm();
        if (s === null || getTime === null || getIsPlaying === null) return;
        snap.playing = getIsPlaying(s, NULL) !== 0;
        snap.master = getTime(s, NULL);
        snap.atUs = nowUs();
        snap.serial = serial;
        const us = snap.atUs - t0;
        if (us > frameCostMax) frameCostMax = us;
        if (us > 1000) perfMark(`bga:${(us / 1000).toFixed(1)}`);
    });

    setInterval(() => {
        try { syncTick(); } catch (e) { log({ t: "bga-sync-error", error: `${e}` }); }
    }, SYNC_INTERVAL_MS);
    log({ t: "bga-ready" });
}
