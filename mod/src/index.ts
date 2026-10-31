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
import { restoreCache } from "./cacheRestore.js";
import { installRecords } from "./records.js";

log({ t: "mod-loaded" });
// 캐시는 Unity가 뜨기 전에만 푼다. mod.js를 push해 다시 읽힐 때(on_change)는 libil2cpp가 이미 올라와 있으니 건너뛴다.
if (Process.findModuleByName("libil2cpp.so") === null) guard("cache-restore", restoreCache);

Il2Cpp.perform(() => {
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
    guard("records", installRecords);
});
