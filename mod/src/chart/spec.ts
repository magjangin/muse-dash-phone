// BMS 차트 → 노트 스펙. PC 모드 DBStageInfoExperimentChart.Bms.cs / .Resolve.cs / .Schema.cs / .DtTable.cs + BmsNoteMatcher.cs + BmsDtTable.cs 이식본.
import type { BmsChart, BmsNote } from "../bms/parser.js";
import { parseWavName } from "../bms/wav.js";
import type { BmsWavInfo } from "../bms/wav.js";

// NoteConfigData.type 코드
export const NoteTypes = { Boss: 0, Normal: 1, Gear: 2, Long: 3, Ghost: 4, Heart: 6, Blue: 7, Sandbag: 8, SceneToggle: 9 } as const;

export interface NoteSpec {
    label: string;
    uid: string;
    prefabName: string;
    keyAudio: string;
    bossAction: string;
    bossName: string;
    bossScene: number;
    scene: string;
    ibmsId: string;
    noteType: number;
    pathway: number;
    isLong: boolean;
    isMul: boolean;
    startTick: number;   // 초 (BMS 노트 시간)
    length: number;      // 초
    speed: number;       // -1 = 자동
    dt: number;          // -1 = 자동
}

// ---- uid(zzxxyy) 해석 ----
export const UidCode = {
    scene: (uid: string | null | undefined) => (uid && uid.length >= 2 ? uid.substr(0, 2) : null),
    xx: (uid: string | null | undefined) => (uid && uid.length >= 4 ? uid.substr(2, 2) : null),
    yy: (uid: string | null | undefined) => (uid && uid.length >= 6 ? uid.substr(4, 2) : null),
    /** yy(01~18)의 속도 1·2·3. 범위 밖 0. 씬 전환(0004yy)·보스 동작(xx=01)의 yy는 속도가 아니다. */
    speed(uid: string | null | undefined): number {
        const yy = laneSpeedYy(uid);
        return yy > 0 ? ((yy - 1) % 3) + 1 : 0;
    },
    /** 0 지상 기본, 1 공중 기본, 2 지상 Up, 3 공중 Up, 4 지상 Down, 5 공중 Down. 범위 밖 -1. */
    motionGroup(uid: string | null | undefined): number {
        const yy = laneSpeedYy(uid);
        return yy > 0 ? Math.floor((yy - 1) / 3) : -1;
    }
};

function laneSpeedYy(uid: string | null | undefined): number {
    if (!uid || uid.length < 6) return 0;
    if (uid.startsWith("0004") || uid.substr(2, 2) === "01") return 0;
    const yy = parseInt(uid.substr(4, 2), 10);
    return yy >= 1 && yy <= 18 ? yy : 0;
}

// 정밀도: 판정 타이밍(tick, dt) 3자리, 배치(config time, length, showTick) 2자리.
export const roundTiming = (v: number) => roundAway(v, 3);
export const roundChart = (v: number) => roundAway(v, 2);
function roundAway(v: number, digits: number): number {
    const f = Math.pow(10, digits);
    return (Math.sign(v) * Math.round(Math.abs(v) * f + 1e-9)) / f;
}

// ---- WAV 정보 캐시 ----
const wavCache = new WeakMap<BmsChart, Map<string, BmsWavInfo | null>>();
export function resolveWavInfo(chart: BmsChart, note: BmsNote): BmsWavInfo | null {
    let cache = wavCache.get(chart);
    if (!cache) { cache = new Map(); wavCache.set(chart, cache); }
    const raw = note.rawValue ?? "";
    if (cache.has(raw)) return cache.get(raw)!;
    const wavName = chart.metadata.get(`WAV${raw.toUpperCase()}`) || `${raw}.wav`;
    const info = parseWavName(wavName);
    cache.set(raw, info);
    return info;
}

// ---- 홀드·샌드백 짝 맞추기 (채널별, 틱 순) ----
interface MatchedPair { kind: "hold" | "sandbag"; start: BmsNote; end: BmsNote; }

function matchSpecialNotes(chart: BmsChart, warnings: string[]): MatchedPair[] {
    const pairs: MatchedPair[] = [];
    const byChannel = new Map<number, BmsNote[]>();
    for (const n of chart.notes) {
        if (!byChannel.has(n.channel)) byChannel.set(n.channel, []);
        byChannel.get(n.channel)!.push(n);
    }
    for (const [channel, notes] of byChannel) {
        let hold: BmsNote | null = null;
        let sandbag: BmsNote | null = null;
        for (const n of notes) {
            const w = resolveWavInfo(chart, n);
            if (!w) continue;
            if (w.noteType === NoteTypes.Long) {
                if (!hold) hold = n; else { pairs.push({ kind: "hold", start: hold, end: n }); hold = null; }
            }
            if (w.noteType === NoteTypes.Sandbag) {
                if (!sandbag) sandbag = n; else { pairs.push({ kind: "sandbag", start: sandbag, end: n }); sandbag = null; }
            }
        }
        if (hold) warnings.push(`홀드 짝 없음: 채널 ${channel}, tick ${hold.tick}`);
        if (sandbag) warnings.push(`샌드백 짝 없음: 채널 ${channel}, tick ${sandbag.tick}`);
    }
    return pairs;
}

// 씬 전환 노트 yy(바꿀 sceneInfo 번호) → 게임 ibms_id. scene 11은 표에 없다.
const SCENE_TOGGLE_IBMS_ID = new Map<number, string>([
    [1, "1O"], [2, "1P"], [3, "1Q"], [4, "1R"], [5, "1S"], [6, "1T"],
    [7, "1U"], [8, "1V"], [9, "1W"], [10, "1X"], [12, "1Y"]
]);

function resolveBmsPathway(w: BmsWavInfo): number {
    // 공중 = yy 묶음이 홀수(공중 기본·Up·Down). 속도 자리가 없는 uid는 예전 규칙(04/10/16).
    const g = UidCode.motionGroup(w.uid);
    if (g >= 0) return g % 2 === 1 ? 1 : 0;
    const yy = UidCode.yy(w.uid);
    return yy === "04" || yy === "10" || yy === "16" ? 1 : 0;
}

function shouldKeepBmsPrefabName(w: BmsWavInfo): boolean {
    if (w.bossAction && w.noteType === NoteTypes.Boss) return true;
    if (!w.prefabName || !w.uid) return false;
    return w.prefabName.toLowerCase() !== w.uid.toLowerCase();
}

function specFromBms(note: BmsNote, w: BmsWavInfo, manifestScene: number | null | undefined, warnings: string[]): NoteSpec {
    const isBossEvent = w.noteType === NoteTypes.Boss && !!w.bossAction;
    const spec: NoteSpec = {
        label: `BMS ${note.rawValue}`,
        uid: w.uid ?? "",
        prefabName: shouldKeepBmsPrefabName(w) ? (w.prefabName ?? "") : "",
        keyAudio: w.keyAudio ?? "",
        bossAction: w.bossAction ?? "",
        bossName: w.bossName ?? "",
        bossScene: w.bossScene,
        scene: "",
        ibmsId: "",
        noteType: w.noteType,
        pathway: resolveBmsPathway(w),
        isLong: false,
        isMul: false,
        startTick: isBossEvent ? note.time : roundChart(note.time),
        length: 0,
        speed: -1,
        dt: w.dt >= 0 ? roundTiming(w.dt) : w.dt
    };
    if (spec.bossAction && spec.uid.length >= 2) spec.scene = `scene_${UidCode.scene(spec.uid)}`;
    if (spec.bossAction && manifestScene != null) spec.scene = `scene_${String(manifestScene).padStart(2, "0")}`;
    if (spec.noteType === NoteTypes.SceneToggle) {
        spec.prefabName = spec.uid;   // 보이지 않는 트리거
        spec.keyAudio = "0";
        const yy = parseInt(UidCode.yy(spec.uid) ?? "", 10);
        const id = SCENE_TOGGLE_IBMS_ID.get(yy);
        if (id) spec.ibmsId = id; else warnings.push(`씬 전환 ibms_id 매핑 없음: uid=${spec.uid}`);
    }
    return spec;
}

// ---- 권장 dt 표 ----
type DtFamily = "none" | "normal" | "hold" | "bossProjectile" | "fixedEvent";
const NORMAL_DT = [1.48, 1.28, 1.18];
const HOLD_DT = [1.47, 1.26, 1.10];
const BOSS_PROJECTILE_DT = [0.8, 0.76, 0.6];

function classifyDt(uid: string, noteType: number, bossAction: string): DtFamily {
    if (uid.startsWith("0004") || noteType === NoteTypes.SceneToggle) return "fixedEvent";
    const xx = UidCode.xx(uid);
    const g = UidCode.motionGroup(uid);
    if ((xx === "06" || xx === "07" || xx === "08") && (g === 0 || g === 1)) return "bossProjectile";
    if (noteType === NoteTypes.Boss && bossAction) return "fixedEvent";
    if (xx === "01") return "fixedEvent";
    if (UidCode.speed(uid) === 0) return "none";
    if (noteType === NoteTypes.Long) return "hold";
    if (noteType === NoteTypes.Sandbag) return "none";
    if (xx === "09") return "none";
    return "normal";
}

function recommendedDt(family: DtFamily, speed: number): number | null {
    if (family === "fixedEvent") return 0;
    const table = family === "normal" ? NORMAL_DT : family === "hold" ? HOLD_DT : family === "bossProjectile" ? BOSS_PROJECTILE_DT : null;
    if (!table || speed < 1 || speed > 3) return null;
    return table[speed - 1];
}

/** info.txt 'dt를 권장 표로 고치기'가 켜졌을 때만 WAV _dt를 권장값으로 덮어쓴다. 바꾼 개수를 돌려준다. */
function applyDtTable(specs: NoteSpec[], fix: boolean): number {
    if (!fix) return 0;
    let changed = 0;
    for (const s of specs) {
        const rec = recommendedDt(classifyDt(s.uid, s.noteType, s.bossAction), UidCode.speed(s.uid));
        if (rec === null) continue;
        if (Math.abs(s.dt - rec) > 0.0005) changed++;
        s.dt = rec;
    }
    return changed;
}

export interface BuildResult { specs: NoteSpec[]; pairs: number; dtChanged: number; warnings: string[]; }

export function buildSpecsFromBms(chart: BmsChart, manifestScene: number | null | undefined, fixDt: boolean): BuildResult {
    const warnings: string[] = [];
    const specs: NoteSpec[] = [];
    const paired = new Set<BmsNote>();
    const pairs = matchSpecialNotes(chart, warnings);
    for (const p of pairs) {
        const w = resolveWavInfo(chart, p.start);
        if (!w) continue;
        paired.add(p.start);
        paired.add(p.end);
        const s = specFromBms(p.start, w, manifestScene, warnings);
        s.label = `BMS ${p.kind} ${p.start.rawValue}`;
        s.startTick = roundChart(p.start.time);
        s.length = roundChart(Math.max(0, p.end.time - p.start.time));
        s.isLong = p.kind === "hold";
        s.isMul = p.kind === "sandbag";
        specs.push(s);
    }
    for (const n of chart.notes) {
        if (paired.has(n)) continue;
        const w = resolveWavInfo(chart, n);
        if (!w) continue;
        if (w.noteType === NoteTypes.Long || w.noteType === NoteTypes.Sandbag) {
            warnings.push(`짝 없는 특수 노트 건너뜀: raw=${n.rawValue}, time=${n.time.toFixed(3)}`);
            continue;
        }
        specs.push(specFromBms(n, w, manifestScene, warnings));
    }
    const dtChanged = applyDtTable(specs, fixDt);
    specs.sort((a, b) => a.startTick - b.startTick || a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return { specs: applyBossAutoSwap(specs), pairs: pairs.length, dtChanged, warnings };
}

/** 보스 out 뒤 처음 나오는(더 늦은) in을 실제 보스 교체(swap:<보스>:<씬>)로 바꾼다. 입력은 tick 순이어야 한다. */
function applyBossAutoSwap(specs: NoteSpec[]): NoteSpec[] {
    let waiting = false;
    let lastOut = 0;
    return specs.map(src => {
        const s = { ...src };
        if (s.bossAction.toLowerCase() === "out") {
            waiting = true;
            lastOut = s.startTick;
            return s;
        }
        if (waiting && s.bossAction.toLowerCase() === "in" && s.startTick > lastOut) {
            const scene = parseInt(UidCode.scene(s.uid) ?? "", 10);
            const bossName = s.bossName || (isNaN(scene) ? "" : `${String(scene).padStart(2, "0")}01_boss`);
            const bossScene = s.bossScene >= 0 ? s.bossScene : (isNaN(scene) ? -1 : scene);
            if (bossName && bossScene >= 0) {
                s.bossAction = `swap:${bossName}:${bossScene}`;
                s.noteType = NoteTypes.Boss;
                s.prefabName = "empty_000";
                s.keyAudio = "";
            }
            waiting = false;
        }
        return s;
    });
}

// ---- 보스 (PC BmsBossSwapPlanner.cs / BossPatch.TryGetFirstBmsBoss) ----
export interface BossTarget { name: string; scene: number; }

/** 차트의 첫 boss in 노트의 보스 — 배틀 시작 보스를 이걸로 바꾼다. */
export function firstBmsBoss(chart: BmsChart): BossTarget | null {
    for (const n of chart.notes) {
        const w = resolveWavInfo(chart, n);
        if (w && (w.bossTransition ?? "").toLowerCase() === "in") {
            return w.bossName && w.bossScene >= 0 ? { name: w.bossName, scene: w.bossScene } : null;
        }
    }
    return null;
}

/** out 뒤에 오는 in = 보스 교체. 교체될 보스들을 미리 만들어 두려고 목록을 뽑는다. */
export function bmsSwapTargets(chart: BmsChart): BossTarget[] {
    const out: BossTarget[] = [];
    let pendingOut = false;
    for (const n of chart.notes) {
        const w = resolveWavInfo(chart, n);
        if (!w) continue;
        const tr = (w.bossTransition ?? "").toLowerCase();
        if (tr === "out") { pendingOut = true; continue; }
        if (pendingOut && tr === "in") {
            if (w.bossName && w.bossScene >= 0) out.push({ name: w.bossName, scene: w.bossScene });
            pendingOut = false;
        }
    }
    return out;
}

// ---- 프리팹·dt 해석 (ApplyNoteSpec에서 씀) ----
function isBossProjectileUid(uid: string): boolean {
    if (!uid || uid.length < 6) return false;
    const xx = UidCode.xx(uid);
    const g = UidCode.motionGroup(uid);
    return (xx === "06" || xx === "07" || xx === "08") && (g === 0 || g === 1);
}

export function buildPrefabName(uid: string, noteType: number, pathway: number): string {
    if (!uid || uid.length < 6) return uid;
    const xx = UidCode.xx(uid);
    const lane = pathway === 1 ? "air" : "road";
    const g = UidCode.motionGroup(uid);
    let motion = "nor";
    if (xx === "15") motion = "down";
    else if (xx === "16") motion = "up";
    else if (g === 2 || g === 3) motion = "up";
    else if (g === 4 || g === 5) motion = "down";
    // 공식 프리팹 끝자리 = 노트 속도. 속도 1 음표(000301/000304 제외)만 _2.
    const speed = UidCode.speed(uid);
    let variant = "1";
    if (speed >= 2) variant = String(speed);
    else if (uid !== "000301" && uid !== "000304" && noteType === NoteTypes.Blue) variant = "2";
    return `${uid}_${lane}_${motion}_${variant}`;
}

export function resolvePrefabName(spec: NoteSpec, noteType: number, uid: string, pathway: number): string | null {
    if (spec.prefabName) return spec.prefabName;
    if (spec.bossAction && noteType === NoteTypes.Boss && !isBossProjectileUid(uid)) return "empty_000";
    if (uid) return buildPrefabName(uid, noteType, pathway);
    return null;
}

const BASE_DT = 1.47;
const BOSS_PROJECTILE_DEFAULT_DT = 0.7;

/** WAV _dt(또는 권장표로 바뀐 값)를 쓰고, 없을 때만 속도 1 기준 기본값. */
export function effectiveDt(spec: NoteSpec): number {
    if (spec.dt >= 0) return spec.dt;
    const uid = spec.uid;
    if (!uid || uid.length < 6) return BASE_DT;
    if (isBossProjectileUid(uid)) return BOSS_PROJECTILE_DEFAULT_DT;
    if (spec.bossAction) return 0;
    const xx = UidCode.xx(uid);
    if (xx === "15") return 0.8;
    if (xx === "16") return 1.25;
    if (UidCode.motionGroup(uid) >= 2) return 1.0;
    return BASE_DT;
}
