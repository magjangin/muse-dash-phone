// 커스텀 곡(1999-N) 최고 기록. 게임 세이브엔 가상 곡 기록이 남지 않으므로(safety.ts가 저장 직전에 지운다)
// files/record/<곡 폴더>_<난이도>.json 에 따로 둔다. PC 모드 CustomRecordStore + PlayRecordMerge +
// CustomRecordUiPatchHelper(PnlRecord) 이식. 키는 uid가 아니라 곡 폴더 이름이다(uid는 폴더 정렬 순번이라
// 곡을 넣고 빼면 밀려 남의 기록이 붙는다). 채보를 바꾸면 지문이 달라져 옛 기록은 보이지 않는다(파일은 남김).
import { MOD_DIR, guard, log } from "./log.js";
import { fileExists, makeDir } from "./native.js";
import { battleSerial, battleSong } from "./customChart.js";
import { lastCounts } from "./chart/inject.js";
import { songForUid } from "./hwa/library.js";
import type { HwaSong } from "./hwa/library.js";
import { shouldAutoPlay } from "./autoplay.js";
import { customAccuracy } from "./battle.js";

const RVA = {
    OnShowVictory: 0x1C808E0,   // PnlVictory2dManager.OnShowVictory
    SetScore: 0x1C69F5C,        // PnlVictory.SetScore() — 승리 화면 점수·최고 점수
    RefreshRecord: 0x1C5E3D4    // PnlRecord.RefreshRecord() — 준비 화면 '최고 기록' 칸
};
// TaskStageTarget (dump.cs)
const TST = { maxCombo: 0x20, score: 0x24, miss: 0x5C, great: 0x64, perfect: 0x68 };
// PnlRecord (dump.cs)
const PR = { txtScore: 0x18, txtGrade: 0x20, txtCombo: 0x28, txtAccuracy: 0x30, txtClear: 0x38, imgIconFc: 0x58 };
// PnlVictory.m_CurControls → PnlVictoryControls (dump.cs)
const PV = { curControls: 0x50, highScoreTxt: 0x48, newBest: 0x70 };

const RECORD_DIR = `${MOD_DIR}/record`;

interface PlayRecord {
    uid: string;
    noteCount: number;
    standard: number;
    gears: number;
    hearts: number;
    blueNotes: number;
    perfect: number;
    great: number;
    miss: number;
    score: number;
    maxCombo: number;
    accuracy: number;
    isFullCombo: boolean;
    isAllPerfect: boolean;
    playCount: number;
    savedAtUtc: string;
    chartFingerprint: string;
    songFolder: string;
}

const libc = Process.getModuleByName("libc.so");
const rename = new NativeFunction(libc.getExportByName("rename"), "int", ["pointer", "pointer"]);

const asm = () => Il2Cpp.domain.assembly("Assembly-CSharp").image;

function battleStage(): Il2Cpp.Object | null {
    const stage = asm().class("Assets.Scripts.Database.GlobalDataBase").field<Il2Cpp.Object>("s_DbBattleStage").value;
    return stage && !stage.isNull() ? stage : null;
}

/** 저장(승리)과 표시(준비 화면)가 같은 출처를 쓰도록 하나로 (PC ResolveCurrentDifficulty). 못 구하면 1. */
function currentDifficulty(): number {
    return battleStage()?.method<number>("get_selectedDifficulty").invoke() ?? 1;
}

/** 준비 화면에서 고른 곡 uid. DataHelper.selectedMusicUid → 없으면 s_DbBattleStage.m_MusicUid. */
function selectedUid(): string | null {
    const fromHelper = asm().class("Assets.Scripts.Database.DataHelper").method<Il2Cpp.String>("get_selectedMusicUid").invoke();
    if (fromHelper && !fromHelper.isNull() && fromHelper.content) return fromHelper.content;
    const uid = battleStage()?.field<Il2Cpp.String>("m_MusicUid").value;
    return uid && !uid.isNull() ? uid.content : null;
}

// 채보 지문: 노트 위치·종류를 FNV-1a로. PC ChartFingerprint와 값은 다르다(기기 기록은 기기에서만 쓴다).
const fingerprints = new Map<HwaSong, string>();
function fingerprint(song: HwaSong): string {
    let fp = fingerprints.get(song);
    if (fp === undefined) {
        let h = 0x811c9dc5;
        for (const n of song.chart.notes) {
            const s = `${n.tick}:${n.channel}:${n.rawValue};`;
            for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
        }
        fp = `android-${song.chart.notes.length}-${h.toString(16).padStart(8, "0")}`;
        fingerprints.set(song, fp);
    }
    return fp;
}

function safeName(name: string): string {
    return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
}

function recordPath(song: HwaSong, difficulty: number): string {
    return `${RECORD_DIR}/${safeName(song.name)}_${difficulty}.json`;
}

function loadRecord(song: HwaSong, difficulty: number): PlayRecord | null {
    const path = recordPath(song, difficulty);
    if (!fileExists(path)) return null;
    const record = JSON.parse(File.readAllText(path)) as PlayRecord;
    if (record.chartFingerprint !== fingerprint(song)) return null;
    if (!(record.playCount > 0)) record.playCount = 1;
    return record;
}

/** PC PlayRecordMerge: 최고 기록은 점수(동점이면 정확도)로만, FC/AP는 한 번 따면 유지, 최고 콤보는 역대 최댓값. */
function merge(existing: PlayRecord | null, next: PlayRecord): PlayRecord {
    if (existing === null) return next;
    const isNewHigh = next.score > existing.score || (next.score === existing.score && next.accuracy > existing.accuracy);
    const best = isNewHigh ? next : existing;
    return {
        ...best,
        maxCombo: Math.max(existing.maxCombo, next.maxCombo),
        isFullCombo: existing.isFullCombo || next.isFullCombo,
        isAllPerfect: existing.isAllPerfect || next.isAllPerfect,
        playCount: existing.playCount + 1
    };
}

function saveRecord(song: HwaSong, difficulty: number, next: PlayRecord): PlayRecord {
    makeDir(RECORD_DIR);
    const path = recordPath(song, difficulty);
    const existing = loadRecord(song, difficulty);
    const merged = merge(existing, next);
    // 덮어쓰기 전 원본을 한 번 .bak으로 남기고(PC KeepBackupBeforeOverwrite), 임시 파일을 거쳐 바꾼다(쓰다 죽어도 옛 기록 유지).
    if (fileExists(path) && !fileExists(`${path}.bak`)) File.writeAllBytes(`${path}.bak`, File.readAllBytes(path));
    File.writeAllText(`${path}.tmp`, `${JSON.stringify(merged, null, 2)}\n`);
    rename(Memory.allocUtf8String(`${path}.tmp`), Memory.allocUtf8String(path));
    return merged;
}

// 이번 판 저장 결과. 승리 화면(SetScore)과 OnShowVictory 중 먼저 오는 쪽이 저장하고, 화면은 이 값을 보여 준다.
let saved: { serial: number; previousBest: number | null; best: number | null } = { serial: -1, previousBest: null, best: null };

function saveVictory(): void {
    const song = battleSong();
    if (!song || saved.serial === battleSerial()) return;
    const difficulty = currentDifficulty();
    const previous = loadRecord(song, difficulty);
    saved = { serial: battleSerial(), previousBest: previous?.score ?? null, best: previous?.score ?? null };
    // 게임도 자동 연주(수면 린)는 기록하지 않는다.
    if (shouldAutoPlay()) {
        log({ t: "record-skip", song: song.name, reason: "autoplay" });
        return;
    }
    const target = asm().class("Assets.Scripts.GameCore.HostComponent.TaskStageTarget").method<Il2Cpp.Object>("get_instance").invoke();
    if (!target || target.isNull()) return;
    const read = (off: number) => target.handle.add(off).readS32();
    const perfect = read(TST.perfect), great = read(TST.great), miss = read(TST.miss);
    const isFullCombo = target.method<boolean>("IsFullCombo").invoke();
    const c = lastCounts;
    const next: PlayRecord = {
        uid: song.virtualUid,
        noteCount: c.standard + c.gears + c.hearts + c.blue,
        standard: c.standard, gears: c.gears, hearts: c.hearts, blueNotes: c.blue,
        perfect, great, miss,
        score: read(TST.score),
        maxCombo: read(TST.maxCombo),
        // 승리 화면에 찍히는 값과 같게 표준 노트 기준(battle.ts의 GetTrueAccuracy 교체본). 실측 MARENOIA 오토 AP: 화면 100.00%.
        // 이 훅 안에서 GetTrueAccuracy를 부르면 교체본이 아니라 게임 원래 계산(0.9859)이 나와서 계산 함수를 직접 쓴다.
        accuracy: customAccuracy(target.handle, false),
        isFullCombo,
        isAllPerfect: isFullCombo && great === 0 && miss === 0,
        playCount: 1,
        savedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        chartFingerprint: fingerprint(song),
        songFolder: song.name
    };
    const merged = saveRecord(song, difficulty, next);
    saved.best = merged.score;
    log({ t: "record-saved", song: song.name, difficulty, score: next.score, best: merged.score, playCount: merged.playCount, acc: next.accuracy, fc: merged.isFullCombo, ap: merged.isAllPerfect });
}

/** 승리 화면 '최고 점수'는 숙주 곡 세이브 기록을 보여 준다 → 커스텀 곡이면 이 곡 기록으로 바꾼다. */
function showVictoryBest(victory: NativePointer): void {
    if (!battleSong()) return;
    saveVictory();
    const controls = victory.add(PV.curControls).readPointer();
    if (controls.isNull()) return;
    const score = asm().class("Assets.Scripts.GameCore.HostComponent.TaskStageTarget").method<Il2Cpp.Object>("get_instance").invoke().handle.add(TST.score).readS32();
    setText(controls, PV.highScoreTxt, `${saved.best ?? 0}`);
    const newBest = controls.add(PV.newBest).readPointer();
    if (!newBest.isNull()) new Il2Cpp.Object(newBest).method("SetActive").invoke(saved.best !== saved.previousBest && score === saved.best);
    log({ t: "record-victory", score, best: saved.best, previousBest: saved.previousBest });
}

function setText(panel: NativePointer, offset: number, text: string): void {
    const p = panel.add(offset).readPointer();
    if (!p.isNull()) new Il2Cpp.Object(p).method("set_text").invoke(Il2Cpp.string(text));
}

/** 게임의 등급 문자열. TaskStageTarget.GetCustomStageEvalute(정확도, FC) → KeyValuePair<string,int>의 key. */
function grade(record: PlayRecord): string | null {
    const target = asm().class("Assets.Scripts.GameCore.HostComponent.TaskStageTarget").method<Il2Cpp.Object>("get_instance").invoke();
    const key = target.method<Il2Cpp.ValueType>("GetCustomStageEvalute").invoke(record.accuracy, record.isFullCombo).field<Il2Cpp.String>("key").value;
    return key && !key.isNull() ? key.content : null;
}

let loggedPanel = false;

function showRecord(panel: NativePointer): void {
    const uid = selectedUid();
    const song = songForUid(uid);
    if (!loggedPanel) { loggedPanel = true; log({ t: "record-panel", uid, custom: song !== null }); }
    if (!song) return;
    const difficulty = currentDifficulty();
    const record = loadRecord(song, difficulty);
    const fc = panel.add(PR.imgIconFc).readPointer();
    if (!record) {
        for (const off of [PR.txtScore, PR.txtGrade, PR.txtCombo, PR.txtAccuracy, PR.txtClear]) setText(panel, off, "-");
        if (!fc.isNull()) new Il2Cpp.Object(fc).method("SetActive").invoke(false);
        return;
    }
    // 풀콤보면 콤보에 들어가는 노트 수(하트·음표 제외)를 넘을 수 없다 (PC FormatCombo).
    const comboNotes = Math.max(0, record.noteCount - record.hearts - record.blueNotes);
    const combo = record.isFullCombo && comboNotes > 0 ? Math.min(record.maxCombo || comboNotes, comboNotes) : record.maxCombo;
    setText(panel, PR.txtScore, `${record.score}`);
    setText(panel, PR.txtCombo, `${combo}`);
    setText(panel, PR.txtAccuracy, `${(record.accuracy * 100).toFixed(2)}%`);
    setText(panel, PR.txtClear, `${record.playCount}`);
    guard("record-grade", () => {
        const g = grade(record);
        if (g) setText(panel, PR.txtGrade, g);
    });
    if (!fc.isNull()) new Il2Cpp.Object(fc).method("SetActive").invoke(record.isFullCombo);
}

export function installRecords(): void {
    const base = Il2Cpp.module.base;
    Interceptor.attach(base.add(RVA.OnShowVictory), {
        onEnter() {
            guard("record-save", saveVictory);
        }
    });
    Interceptor.attach(base.add(RVA.SetScore), {
        onEnter(args) {
            (this as any).victory = args[0];
        },
        onLeave() {
            const victory: NativePointer = (this as any).victory;
            guard("record-victory", () => showVictoryBest(victory));
        }
    });
    Interceptor.attach(base.add(RVA.RefreshRecord), {
        onEnter(args) {
            (this as any).panel = args[0];
        },
        onLeave() {
            const panel: NativePointer = (this as any).panel;
            guard("record-show", () => showRecord(panel));
        }
    });
    log({ t: "records-ready" });
}
