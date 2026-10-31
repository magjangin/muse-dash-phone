// save custom key/config.txt 전역 설정 파일 관리 모듈 (PC InputOverlay.Config.cs 이식).
// 경로: <앱 files>/save custom key/config.txt
// 지원 항목: 오토플레이, 강제퍼펙트, 피버충전금지, 시네마, 고스트노트보이기
import { MOD_DIR, log, guard } from "./log.js";
import { readText, fileExists, makeDir } from "./native.js";
import { setGlobalAutoPlay } from "./autoplay.js";
import { setForcePerfect } from "./allPerfect.js";
import { setGlobalBlockFever } from "./fever.js";
import { onFrame } from "./frame.js";

export const CONFIG_DIR = `${MOD_DIR}/save custom key`;
export const CONFIG_PATH = `${CONFIG_DIR}/config.txt`;

export interface ModConfig {
    autoPlay: boolean;
    forcePerfect: boolean;
    blockFever: boolean;
    enableCinema: boolean;
    showGhostNotes: boolean;
}

export let currentConfig: ModConfig = {
    autoPlay: false,
    forcePerfect: true,
    blockFever: false,
    enableCinema: true,
    showGhostNotes: true
};

const DEFAULT_CONFIG_TEXT = `# ============================================================================
#  [Muse Dash Mod Config - save custom key]
#  이 파일을 편집하여 오토플레이, 판정 강제, 피버, 시네마 등을 제어할 수 있습니다.
#  (인게임 플레이 중에도 실시간으로 감지되어 반영됩니다)
# ============================================================================

# ----------------------------------------------------------------------------
#  [1] 플레이 보조
#  - 오토플레이   : 차트를 완전 자동으로 연주합니다. (true / false)
#  - 강제퍼펙트   : 타격 판정을 무조건 Perfect로 올립니다. (true / false)
#  - 피버충전금지 : 피버 게이지가 차지 않게 막습니다. (true / false)
# ----------------------------------------------------------------------------
오토플레이=false
강제퍼펙트=true
피버충전금지=false

# ----------------------------------------------------------------------------
#  [2] 연출
#  - 시네마       : 커스텀 곡의 BGA 비디오(.mp4)를 재생합니다. (true / false)
#  - 고스트노트보이기 : 고스트 노트가 투명해지지 않게 유지합니다. (true / false)
# ----------------------------------------------------------------------------
시네마=true
고스트노트보이기=true
`;

function ensureConfigFile(): void {
    try {
        makeDir(CONFIG_DIR);

        if (!fileExists(CONFIG_PATH)) {
            const f = new File(CONFIG_PATH, "w");
            f.write(DEFAULT_CONFIG_TEXT);
            f.flush();
            f.close();
            log({ t: "config-created", path: CONFIG_PATH });
        }
    } catch (e) {
        log({ t: "config-ensure-error", error: `${e}` });
    }
}

function parseBool(val: string, fallback: boolean): boolean {
    const v = val.trim().toLowerCase();
    if (["true", "1", "on", "yes", "활성화", "켜기", "켜짐"].includes(v)) return true;
    if (["false", "0", "off", "no", "비활성화", "끄기", "끔"].includes(v)) return false;
    return fallback;
}

let lastContent = "";
let lastCheckTime = 0;

export function reloadConfig(): void {
    guard("reload-config", () => {
        if (!fileExists(CONFIG_PATH)) {
            ensureConfigFile();
        }
        const text = readText(CONFIG_PATH);
        if (text === lastContent) return;
        lastContent = text;

        const lines = text.split(/\r?\n/);
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith("#") || line.startsWith("//")) continue;

            const eq = line.indexOf("=");
            if (eq < 0) continue;

            const key = line.substring(0, eq).replace(/\s+/g, "").toLowerCase();
            const val = line.substring(eq + 1).trim();

            if (key === "오토플레이" || key === "autoplay") {
                currentConfig.autoPlay = parseBool(val, currentConfig.autoPlay);
            } else if (key === "강제퍼펙트" || key === "forceperfect" || key === "올퍼펙트") {
                currentConfig.forcePerfect = parseBool(val, currentConfig.forcePerfect);
            } else if (key === "피버충전금지" || key === "blockfever" || key === "피버차단") {
                currentConfig.blockFever = parseBool(val, currentConfig.blockFever);
            } else if (key === "시네마" || key === "cinema" || key === "bga") {
                currentConfig.enableCinema = parseBool(val, currentConfig.enableCinema);
            } else if (key === "고스트노트보이기" || key === "공식곡에서도고스트노트보이기" || key === "ghostnotes") {
                currentConfig.showGhostNotes = parseBool(val, currentConfig.showGhostNotes);
            }
        }

        // 각 모듈에 전역 설정 즉시 전달
        setGlobalAutoPlay(currentConfig.autoPlay);
        setForcePerfect(currentConfig.forcePerfect);
        setGlobalBlockFever(currentConfig.blockFever);

        log({
            t: "config-loaded",
            autoPlay: currentConfig.autoPlay,
            forcePerfect: currentConfig.forcePerfect,
            blockFever: currentConfig.blockFever,
            enableCinema: currentConfig.enableCinema,
            showGhostNotes: currentConfig.showGhostNotes
        });
    });
}

export function installConfig(): void {
    ensureConfigFile();
    reloadConfig();

    // 1초 주기로 실시간 설정 변경 감지 (PC InputOverlay.LoadConfigIfNeeded 이식)
    onFrame("config", () => {
        const now = Date.now();
        if (now - lastCheckTime > 1000) {
            lastCheckTime = now;
            reloadConfig();
        }
    });

    log({ t: "config-ready" });
}
