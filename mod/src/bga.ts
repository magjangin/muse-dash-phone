// 안드로이드 네이티브 BGA 비디오 재생 (PC HwaBattleMediaController.cs 이식본).
// Unity의 VideoModule이 스트리핑되어 있으므로, Android 네이티브 MediaPlayer + TextureView를
// UnityPlayerActivity에 오버레이/배경으로 연결하여 하드웨어 가속 비디오 재생을 수행합니다.
declare const Java: any;
import { log } from "./log.js";
import { battleSong, currentCustomSong } from "./customChart.js";

let isPlaying = false;
let currentMp4: string | null = null;

export function startBga(mp4Path: string): void {
    if (isPlaying) stopBga();
    if (!mp4Path) return;

    try {
        Java.perform(() => {
            const ActivityThread = Java.use("android.app.ActivityThread");
            const currentApp = ActivityThread.currentApplication();
            const context = currentApp.getApplicationContext();

            // Unity Activity
            const UnityPlayer = Java.use("com.unity3d.player.UnityPlayer");
            const activity = UnityPlayer.currentActivity.value;
            if (!activity) {
                log({ t: "bga-error", error: "UnityPlayer.currentActivity is null" });
                return;
            }

            const MediaPlayer = Java.use("android.media.MediaPlayer");
            const player = MediaPlayer.$new();
            const File = Java.use("java.io.File");
            const file = File.$new(mp4Path);
            if (!file.exists()) {
                log({ t: "bga-file-not-found", path: mp4Path });
                return;
            }

            player.setDataSource(mp4Path);
            player.setLooping(true);
            player.setVolume(0.0, 0.0); // 오디오는 BGM OGG가 담당하므로 음소거

            // UI 스레드에서 TextureView 생성
            const Runnable = Java.use("java.lang.Runnable");
            const TextureView = Java.use("android.view.TextureView");
            const Surface = Java.use("android.view.Surface");
            const FrameLayout = Java.use("android.widget.FrameLayout");
            const LayoutParams = Java.use("android.widget.FrameLayout$LayoutParams");
            const Color = Java.use("android.graphics.Color");

            let textureViewInstance: any = null;

            const setupRunnable = Java.registerClass({
                name: "com.prpr.musedash.mod.BgaSetupRunnable_" + Date.now(),
                implements: [Runnable],
                methods: {
                    run() {
                        try {
                            const textureView = TextureView.$new(activity);
                            textureView.setAlpha(0.5); // 게임 노트 가독성을 위한 투명도 50%
                            textureViewInstance = textureView;

                            const SurfaceTextureListener = Java.use("android.view.TextureView$SurfaceTextureListener");
                            const listener = Java.registerClass({
                                name: "com.prpr.musedash.mod.BgaSurfaceListener_" + Date.now(),
                                implements: [SurfaceTextureListener],
                                methods: {
                                    onSurfaceTextureAvailable(surfaceTexture: any, width: number, height: number) {
                                        try {
                                            const surface = Surface.$new(surfaceTexture);
                                            player.setSurface(surface);
                                            player.prepareAsync();
                                        } catch (e) {
                                            log({ t: "bga-surface-error", error: `${e}` });
                                        }
                                    },
                                    onSurfaceTextureSizeChanged(surface: any, width: number, height: number) {},
                                    onSurfaceTextureDestroyed(surface: any) {
                                        return true;
                                    },
                                    onSurfaceTextureUpdated(surface: any) {}
                                }
                            });

                            textureView.setSurfaceTextureListener(listener.$new());

                            const OnPreparedListener = Java.use("android.media.MediaPlayer$OnPreparedListener");
                            const prepListener = Java.registerClass({
                                name: "com.prpr.musedash.mod.BgaPrepListener_" + Date.now(),
                                implements: [OnPreparedListener],
                                methods: {
                                    onPrepared(mp: any) {
                                        try {
                                            mp.start();
                                            log({ t: "bga-started", path: mp4Path });
                                        } catch (e) {
                                            log({ t: "bga-play-error", error: `${e}` });
                                        }
                                    }
                                }
                            });
                            player.setOnPreparedListener(prepListener.$new());

                            const lp = LayoutParams.$new(
                                LayoutParams.MATCH_PARENT.value,
                                LayoutParams.MATCH_PARENT.value
                            );

                            const root = activity.findViewById(16908290); // android.R.id.content
                            const viewGroup = Java.cast(root, FrameLayout);
                            viewGroup.addView(textureView, 0, lp); // 가장 뒤쪽(인덱스 0) 레이어에 추가

                            (globalThis as any).__bgaPlayer = player;
                            (globalThis as any).__bgaView = textureView;
                            (globalThis as any).__bgaRoot = viewGroup;
                            isPlaying = true;
                            currentMp4 = mp4Path;
                        } catch (e) {
                            log({ t: "bga-ui-error", error: `${e}` });
                        }
                    }
                }
            });

            activity.runOnUiThread(setupRunnable.$new());
        });
    } catch (e) {
        log({ t: "bga-init-error", error: `${e}` });
    }
}

export function stopBga(): void {
    if (!isPlaying) return;
    isPlaying = false;
    currentMp4 = null;

    try {
        Java.perform(() => {
            const player = (globalThis as any).__bgaPlayer;
            const view = (globalThis as any).__bgaView;
            const root = (globalThis as any).__bgaRoot;

            if (player) {
                try {
                    player.stop();
                    player.release();
                } catch (e) {}
                (globalThis as any).__bgaPlayer = null;
            }

            if (view && root) {
                const UnityPlayer = Java.use("com.unity3d.player.UnityPlayer");
                const activity = UnityPlayer.currentActivity.value;
                if (activity) {
                    const Runnable = Java.use("java.lang.Runnable");
                    const cleanupRunnable = Java.registerClass({
                        name: "com.prpr.musedash.mod.BgaCleanupRunnable_" + Date.now(),
                        implements: [Runnable],
                        methods: {
                            run() {
                                try {
                                    root.removeView(view);
                                    log({ t: "bga-stopped" });
                                } catch (e) {}
                            }
                        }
                    });
                    activity.runOnUiThread(cleanupRunnable.$new());
                }
                (globalThis as any).__bgaView = null;
                (globalThis as any).__bgaRoot = null;
            }
        });
    } catch (e) {
        log({ t: "bga-stop-error", error: `${e}` });
    }
}

export function installBga(): void {
    log({ t: "bga-ready" });
}
