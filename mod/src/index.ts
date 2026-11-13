// Muse Dash Android 6.8.0 복제본(com.prpr.musedash.mod) 모드 진입점. Gadget script 모드가 이 번들(mod.js)을 실행한다.
// 빌드: mod/ 에서 `npm run build` → dist/mod.js → 기기 files/mod.js 로 push (on_change=reload).
// 공개본에는 유료 콘텐츠(DLC·Muse Plus) 해금 코드가 없다. 숙주 곡은 무료 곡이나 이미 가진 곡을 쓴다.
import "frida-il2cpp-bridge";
import { guard, log } from "./log.js";
import { probe } from "./probe.js";
import { installConfig } from "./config.js";
import { installCustomChart } from "./customChart.js";
import { installCustomTag } from "./customTag.js";
import { installSafety } from "./safety.js";
import { installBattle } from "./battle.js";
import { installGhost } from "./ghost.js";
import { installHitPoints } from "./hitpoints.js";
import { installProgress } from "./progress.js";
import { installAutoPlay } from "./autoplay.js";
import { installAllPerfect } from "./allPerfect.js";
import { installBga } from "./bga.js";
import { installFever } from "./fever.js";
import { installChristmas } from "./christmas.js";
import { installSpineSkin } from "./spineSkin.js";
import { restoreCache } from "./cacheRestore.js";
import { installRecords } from "./records.js";
import { installWatchdog } from "./watchdog.js";
import { pullFromAssistant } from "./hwa/assistant.js";
import { HWA_DIR } from "./hwa/library.js";

log({ t: "mod-loaded" });
// 캐시 복원과 비서 앱 곡 가져오기는 Unity가 뜨기 전(onCreate 안, 훅·IL2CPP 연결 없음)에만 한다.
// mod.js를 push해 다시 읽힐 때(on_change)는 libil2cpp가 이미 올라와 있으니 건너뛴다.
// 비서 앱 동기화는 예전엔 Il2Cpp.perform 안(스크립트 스레드가 IL2CPP에 붙은 채, Unity 로딩과 동시)에서 돌았고,
// 2026-11-07 21:57에 그 안에서 영영 돌아오지 않아 로딩 화면이 멈췄다.
if (Process.findModuleByName("libil2cpp.so") === null) {
    guard("cache-restore", restoreCache);
    guard("assistant-sync", () => pullFromAssistant(HWA_DIR));
}

// Il2Cpp.perform은 libil2cpp가 아직 없으면 Process.attachModuleObserver를 쓴다(이 기기에서 linker SIGABRT를 낸 API).
// 모듈이 올라올 때까지만 직접 폴링하고, il2cpp_init 완료 대기는 브리지에 맡긴다(브리지가 il2cpp_init onLeave를 기다림).
// corlib != NULL로 init 끝을 판단하면 안 된다: corlib은 il2cpp_init 도중에 채워져서, 그때 훅을 걸자
// safety 설치가 "access violation accessing 0x0"(Il2Cpp.Type.object)로 죽었다(2026-11-09 실측).
function whenIl2CppLoaded(start: () => void): void {
    if (Process.findModuleByName("libil2cpp.so") !== null) { start(); return; }
    const timer = setInterval(() => {
        if (Process.findModuleByName("libil2cpp.so") === null) return;
        clearInterval(timer);
        log({ t: "il2cpp-module-loaded" });
        start();
    }, 5);
}

// "free": 훅 설치가 끝나면 스크립트 스레드를 IL2CPP에서 뗀다. 기본값("bind")은 스크립트가 끝날 때까지 붙여 두어
// IL2CPP GC가 멈출 때마다 이 스레드도 세워야 했다(로딩 중 LoadFromName에서 멈춘 판들의 유력한 원인).
// 이후 IL2CPP를 부르는 코드는 전부 게임 스레드 훅 안에서 돈다(스크립트 스레드 타이머는 watchdog만, IL2CPP 안 씀).
whenIl2CppLoaded(() => Il2Cpp.perform(() => {
    log({ t: "il2cpp-ready", base: Il2Cpp.module.base.toString() });
    guard("safety", installSafety);
    guard("probe", probe);
    guard("config", installConfig);
    guard("custom-chart", installCustomChart);
    guard("custom-tag", installCustomTag);
    guard("battle", installBattle);
    guard("ghost", installGhost);
    guard("hitpoints", installHitPoints);
    guard("progress", installProgress);
    guard("autoplay", installAutoPlay);
    guard("all-perfect", installAllPerfect);
    guard("bga", installBga);
    guard("fever", installFever);
    guard("christmas", installChristmas);
    guard("spine-skin", installSpineSkin);
    guard("records", installRecords);
    guard("watchdog", installWatchdog);
}, "free"));
