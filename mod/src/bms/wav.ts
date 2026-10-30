// #WAVxx 파일명 → 노트 정보. PC 모드 Bms/BmsWavParser.cs 이식본.
// 파일명 규칙: 앞 6자리 uid(zzxxyy, zz=씬 xx=종류 yy=속도·레인), "_dt1.48" = 선행 표시 시간, "_boss"/"boss_in" 등 = 보스 표식.

export interface BmsWavInfo {
    rawWavName: string;
    uid?: string;
    prefabName?: string;
    dt: number;               // -1 = 선언 없음
    noteType: number;         // 기본 1 = 일반 노트
    keyAudio?: string;
    bossAction?: string;
    bossTransition?: string;
    bossName?: string;
    bossScene: number;        // -1 = 없음
}

const DT = /_dt([0-9]+(?:\.[0-9]+)?)(?:\.wav)?$/i;
const UID = /^([0-9]{6})/;

// 보스를 동반한 발사체/톱니 노트에서 _dt 선언이 없을 때 쓰는 기본 선행 표시 시간.
const BOSS_PROJECTILE_DEFAULT_DT = 0.7;

// uid 앞 4자리 → (NoteType, 키 오디오) 접두사 우선 매핑
const UID_PREFIX_NOTE_TYPE = new Map<string, [number, string | undefined]>([
    ["0002", [6, "sfx_hp"]],    // HP / 하트
    ["0003", [7, "sfx_score"]], // 음표
    ["0004", [9, undefined]]    // 씬 전환 토글 (xx=04 샌드백과 충돌해 접두사로 먼저 분류)
]);

// uid xx(3~4번째 자리) → NoteType
const XX_NOTE_TYPE = new Map<string, number>([
    ["02", 3], // 홀드
    ["03", 2], // 장애물 / 보스 톱니
    ["04", 8], // 샌드백(연타)
    ["09", 2], // 보스 톱니
    ["17", 4]  // 고스트
]);

// xxyy → (보스 액션, 전환) — xx=01 보스 전환 표
const XXYY_TRANSITION = new Map<string, [string, string | undefined]>([
    ["0101", ["in", "in"]],
    ["0102", ["out", "out"]],
    ["0107", ["boss_far_atk_1_start", undefined]],
    ["0108", ["boss_far_atk_1_end", undefined]],
    ["0109", ["boss_far_atk_2_start", undefined]],
    ["0110", ["boss_far_atk_2_end", undefined]],
    ["0113", ["multi_atk_48", undefined]],
    ["0114", ["multi_atk_48_end", undefined]]
]);

// xxyy → 보스 액션 — 발사체/톱니 자동 매핑
const XXYY_PROJECTILE_ACTION = new Map<string, string>([
    ["0601", "boss_far_atk_1_R"], ["0902", "boss_far_atk_1_R"], ["0903", "boss_far_atk_1_R"],
    ["0604", "boss_far_atk_1_L"], ["0906", "boss_far_atk_1_L"],
    ["0701", "boss_far_atk_2"], ["0704", "boss_far_atk_2"],
    ["0801", "boss_far_atk_2"], ["0804", "boss_far_atk_2"],
    ["0908", "boss_far_atk_2"], ["0909", "boss_far_atk_2"],
    ["0911", "boss_far_atk_2"], ["0912", "boss_far_atk_2"]
]);

function stripExtension(name: string): string {
    const base = name.replace(/^.*[\\/]/, "");
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.substring(0, dot) : base;
}

export function parseWavName(wavName: string): BmsWavInfo | null {
    if (!wavName || wavName.trim().length === 0) return null;
    const info: BmsWavInfo = { rawWavName: wavName, dt: -1, noteType: 1, bossScene: -1 };
    const name = stripExtension(wavName);

    const uidMatch = UID.exec(name);
    if (uidMatch) {
        info.uid = uidMatch[1];
        info.prefabName = normalizePrefabName(name, info.uid);
    }
    const dtMatch = DT.exec(name);
    if (dtMatch) {
        const dt = parseFloat(dtMatch[1]);
        if (!isNaN(dt)) info.dt = Math.round(dt * 1000) / 1000;
        info.prefabName = normalizePrefabName(name, info.uid);
    }

    const lower = name.toLowerCase();
    let typeResolvedFromUid = false;
    if (info.uid && info.uid.length === 6) {
        const xx = info.uid.substr(2, 2);
        const xxyy = info.uid.substr(2, 4);
        const prefix = UID_PREFIX_NOTE_TYPE.get(info.uid.substr(0, 4));
        if (prefix) {
            info.noteType = prefix[0];
            info.keyAudio = prefix[1];
            typeResolvedFromUid = true;
        } else if (XX_NOTE_TYPE.has(xx)) {
            info.noteType = XX_NOTE_TYPE.get(xx)!;
            typeResolvedFromUid = true;
        }
        if (XXYY_TRANSITION.has(xxyy)) typeResolvedFromUid = true;
        applyBossTransitionFromXxyy(info, xxyy);

        if (xx === "06" || xx === "07" || xx === "08" || xx === "09") typeResolvedFromUid = true;
        applyBossProjectileAction(info, lower, xx, xxyy);
    }
    applyFallbackNoteType(info, lower, name, typeResolvedFromUid);
    return info;
}

/** 보스 발사체(xx=06/07/08)의 속도 2·3 uid를 같은 레인의 속도 1 xxyy로 바꾼다(yy 02·03 → 01, 05·06 → 04). 톱니(09)는 그대로. */
function speedOneProjectileXxyy(xx: string, xxyy: string): string {
    if (xx !== "06" && xx !== "07" && xx !== "08") return xxyy;
    const yy = parseInt(xxyy.substr(2, 2), 10);
    if (isNaN(yy) || yy < 1 || yy > 6) return xxyy;
    return xx + (yy <= 3 ? "01" : "04");
}

function applyBossProjectileAction(info: BmsWavInfo, lower: string, xx: string, xxyy: string): void {
    const projectile = xx === "06" || xx === "07" || xx === "08";
    const gear = xx === "09";
    if (!projectile && !gear) return;

    if (lower.includes("_boss") || lower.includes("_atk")) {
        if (lower.includes("boss_far_atk_1_r")) info.bossAction = "boss_far_atk_1_R";
        else if (lower.includes("boss_far_atk_1_l")) info.bossAction = "boss_far_atk_1_L";
        else if (lower.includes("boss_far_atk_2")) info.bossAction = "boss_far_atk_2";
        else {
            const mapped = XXYY_PROJECTILE_ACTION.get(speedOneProjectileXxyy(xx, xxyy));
            if (mapped) info.bossAction = mapped;
        }
        // 선언된 _dt를 덮지 않는다. 선언이 없을 때만 보스 전조 시간 0.7초.
        if (info.dt < 0) info.dt = BOSS_PROJECTILE_DEFAULT_DT;
    } else {
        info.bossAction = "";
    }
}

/** 이름 기반 노트 타입 추정 — uid로 타입이 안 정해졌을 때만 쓰는 폴백. 보스 표식(boss_swap/out/in)은 항상 존중. */
function applyFallbackNoteType(info: BmsWavInfo, lower: string, name: string, typeResolvedFromUid: boolean): void {
    if (info.uid && info.uid.startsWith("0004")) {
        info.noteType = 9; // 씬 전환
        return;
    }
    if (lower.includes("boss_swap")) {
        info.noteType = 0;
        info.prefabName = "empty_000";
        info.bossAction = "swap:0401_boss:4";
        return;
    }
    if (lower.includes("boss_out")) {
        info.noteType = 0;
        info.prefabName = "empty_000";
        info.bossAction = "out";
        info.bossTransition = "out";
        return;
    }
    if (lower.includes("boss_in")) {
        info.noteType = 0;
        info.prefabName = "empty_000";
        info.bossAction = "in";
        info.bossTransition = "in";
        applyBossTargetFromName(info, name);
        return;
    }
    if (typeResolvedFromUid) return;

    const xx = info.uid ? info.uid.substr(2, 2) : null;
    if (lower.includes("heart") || lower.includes("hp") || info.uid?.startsWith("0002")) {
        info.noteType = 6;
        info.keyAudio = "sfx_hp";
    } else if (lower.includes("score") || lower.includes("note") || info.uid?.startsWith("0003")) {
        info.noteType = 7;
        info.keyAudio = "sfx_score";
    } else if (lower.includes("sandbag") || xx === "04") {
        info.noteType = 8;
    } else if (lower.includes("hold") || lower.includes("long") || xx === "02") {
        info.noteType = 3;
    } else if (xx === "17") {
        info.noteType = 4;
    }
}

function applyBossTargetFromName(info: BmsWavInfo, name: string): void {
    const boss = /([0-9]{4}_boss)/i.exec(name);
    if (boss) info.bossName = boss[1].toLowerCase();
    const scene = /(?:scene|sc|s)([0-9]{1,2})/i.exec(name);
    if (scene) info.bossScene = parseInt(scene[1], 10);
    if (!info.bossName && info.uid && info.uid.length >= 2) info.bossName = info.uid.substr(0, 2) + "01_boss";
    if (info.bossScene < 0 && info.uid && info.uid.length >= 2) {
        const s = parseInt(info.uid.substr(0, 2), 10);
        if (!isNaN(s)) info.bossScene = s;
    }
}

function normalizePrefabName(name: string, uid?: string): string | undefined {
    if (!name || name.trim().length === 0) return uid;
    let prefab = name;
    const dtIdx = prefab.toLowerCase().indexOf("_dt");
    if (dtIdx > 0) prefab = prefab.substring(0, dtIdx);
    if (!uid) return prefab;
    if (containsHumanLabel(prefab)) return uid;
    return prefab;
}

function containsHumanLabel(text: string): boolean {
    for (const ch of text) {
        if (ch.charCodeAt(0) > 127 || /\s/.test(ch) || "()[]".includes(ch)) return true;
    }
    return false;
}

function applyBossTransitionFromXxyy(info: BmsWavInfo, xxyy: string): void {
    const entry = XXYY_TRANSITION.get(xxyy);
    if (!entry) return;
    info.noteType = 0;
    info.prefabName = "empty_000";
    info.bossAction = entry[0];
    if (entry[1] !== undefined) info.bossTransition = entry[1];
    if (info.uid && info.uid.length >= 2) {
        if (!info.bossName) info.bossName = info.uid.substr(0, 2) + "01_boss";
        if (info.bossScene < 0) {
            const s = parseInt(info.uid.substr(0, 2), 10);
            if (!isNaN(s)) info.bossScene = s;
        }
    }
}
