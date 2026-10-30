// DBStageInfo.SetRuntimeMusicData(List<MusicData>) 직후, 숙주 곡 노트 목록을 BMS 노트로 갈아 끼운다.
// PC 모드 DBStageInfoPatch.cs + DBStageInfoExperimentChart.cs / .Sorting.cs 이식본. 원본 [0](앵커)은 유지하고 [1]을 템플릿으로 복제한다.
// 이 빌드의 MusicData는 0x160바이트 struct라 List<MusicData>._items(MusicData[])에 값으로 들어 있다 → 새 배열을 만들어 _items/_size를 바꾼다.
import { log } from "../log.js";
import { pinnedString, readDecimal, readIl2CppString, writeDecimal } from "../native.js";
import type { HwaSong } from "../hwa/library.js";
import { NoteTypes, UidCode, buildSpecsFromBms, effectiveDt, resolvePrefabName, roundChart, roundTiming } from "./spec.js";
import type { NoteSpec } from "./spec.js";

// ---- MusicData 오프셋 (dump.cs, struct 값 기준) ----
const MD = {
    objId: 0x0, tick: 0x4,
    cfg: 0x18,           // MusicConfigData: id 0, time 4, note_uid 0x18, length 0x20, blood 0x30, pathway 0x34
    note: 0x50,          // NoteConfigData (크기 0xC0)
    isLongPressing: 0x110, doubleIdx: 0x114, isDouble: 0x120, isLongPressEnd: 0x121,
    longPressPTick: 0x124, endIndex: 0x134, dt: 0x138, longPressNum: 0x148, showTick: 0x14C
};
const NC = {
    id: 0x0, ibms_id: 0x8, uid: 0x10, mirror_uid: 0x18, scene: 0x20, prefab_name: 0x30, type: 0x38,
    effect: 0x40, key_audio: 0x48, boss_action: 0x50, sceneChangeNames: 0x58,
    pathway: 0xA4, speed: 0xA8, isShowPlayEffect: 0xB7, noteUid: 0xBC
};
const NOTE_CONFIG_SIZE = 0xC0;
const CFG = { id: 0x0, time: 0x4, note_uid: 0x18, length: 0x20, pathway: 0x34 };
// List<T>: _items 0x10, _size 0x18, _version 0x1C. 배열 데이터는 0x20부터.
const LIST_ITEMS = 0x10, LIST_SIZE = 0x18, LIST_VERSION = 0x1C, ARRAY_DATA = 0x20;
const DBSTAGEINFO_MUSICLIST = 0x40;
const LONG_MIDDLE_STEP = 0.1;
const SHORT_MAX = 32767;

/** 직렬화 전 노트 한 개. 정렬·재연결을 JS에서 끝낸 뒤 한 번에 네이티브 배열로 쓴다. */
interface NoteRec {
    official: NativePointer | null;   // 아이템 노트(하트·음표)는 공식 노트 표 행을 바탕으로
    objId: number;
    tick: number; dt: number; showTick: number;
    cfgTime: number; cfgLength: number;
    uid: string; type: number; pathway: number;
    prefab: string | null; keyAudio: string | null; bossAction: string | null; scene: string | null; ibmsId: string | null;
    speed: number | null; isShowPlayEffect: boolean | null; effect: string | null; noteUid: number | null;
    isLongPressing: boolean; isLongPressEnd: boolean; longPressPTick: number; endIndex: number; longPressNum: number;
    isDouble: boolean; doubleIdx: number;
}

interface Template { bytes: NativePointer; type: number; pathway: number; effect: string | null; }

let officialRowCache = new Map<string, NativePointer | null>();

function officialRow(uid: string): NativePointer | null {
    if (officialRowCache.has(uid)) return officialRowCache.get(uid)!;
    let row: NativePointer | null = null;
    try {
        const mgr = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.GameCore.Managers.NoteDataMananger");
        const instance = mgr.method<Il2Cpp.Object>("get_instance").invoke();
        const value = instance.method<Il2Cpp.ValueType>("GetNoteByUid").invoke(Il2Cpp.string(uid));
        if (readIl2CppString(value.handle.add(NC.uid).readPointer()) === uid) {
            row = Memory.alloc(NOTE_CONFIG_SIZE);
            Memory.copy(row, value.handle, NOTE_CONFIG_SIZE);
        }
    } catch (e) {
        log({ t: "chart-official-row-error", uid, error: `${e}` });
    }
    officialRowCache.set(uid, row);
    return row;
}

function isSceneToggle(r: NoteRec): boolean {
    return r.type === NoteTypes.SceneToggle || r.uid.startsWith("0004");
}

// ---- PC MoveNote + ApplyNoteSpec + ResetRuntimeFlags ----
function makeNote(tpl: Template, objId: number, tick: number, length: number, spec: NoteSpec): NoteRec {
    let noteType = spec.noteType >= 0 ? spec.noteType : tpl.type;
    const uid = spec.uid;
    // 음표·하트를 일반 노트로 복제하면 타격 판정(PERFECT)으로 집계된다 → 공식 노트 표 행을 바탕으로.
    const official = (noteType === NoteTypes.Blue || noteType === NoteTypes.Heart) && uid ? officialRow(uid) : null;
    const basePathway = official ? official.add(NC.pathway).readS32() : tpl.pathway;
    const pathway = spec.pathway >= 0 ? spec.pathway : basePathway;
    if (spec.isLong) noteType = NoteTypes.Long;
    if (spec.isMul) noteType = NoteTypes.Sandbag;

    const isBossEvent = spec.noteType === NoteTypes.Boss && !!spec.bossAction;
    const tickN = roundTiming(tick);
    const dt = roundTiming(effectiveDt(spec));

    let scene: string | null = null;
    if (spec.bossAction && uid.length >= 2) scene = `scene_${UidCode.scene(uid)}`;
    if (spec.scene) scene = spec.scene;

    let speed: number | null = null;
    if (spec.speed >= 0) speed = Math.round(spec.speed);
    else if (UidCode.speed(uid) >= 2) speed = UidCode.speed(uid);

    const r: NoteRec = {
        official, objId,
        tick: tickN, dt, showTick: roundChart(tickN - dt),
        cfgTime: isBossEvent ? tick : tickN, cfgLength: roundChart(length),
        uid, type: noteType, pathway,
        prefab: resolvePrefabName(spec, noteType, uid, pathway),
        keyAudio: spec.keyAudio || null,
        bossAction: spec.bossAction || null,
        scene,
        ibmsId: spec.ibmsId || null,
        speed,
        isShowPlayEffect: official ? null : noteType !== NoteTypes.Long,
        effect: official ? null : (!tpl.effect || tpl.effect === "0" ? "1" : null),
        noteUid: /^\d+$/.test(uid) ? parseInt(uid, 10) : null,
        isLongPressing: false, isLongPressEnd: false, longPressPTick: 0, endIndex: 0, longPressNum: 0,
        isDouble: false, doubleIdx: 0
    };
    if (isSceneToggle(r)) r.doubleIdx = -1;
    if (r.type === NoteTypes.Boss && r.bossAction) r.doubleIdx = -1;
    return r;
}

function addSpec(out: NoteRec[], tpl: Template, spec: NoteSpec): void {
    if (!spec.isLong) {
        const length = spec.isMul ? (spec.length > 0 ? spec.length : 1) : 0;
        out.push(makeNote(tpl, out.length, spec.startTick, length, spec));
        return;
    }
    const length = spec.length > 0 ? spec.length : 1;
    const startIndex = out.length;
    const count = Math.ceil(length / LONG_MIDDLE_STEP);
    const middles = Math.max(0, count - 1);
    const endIndex = startIndex + middles + 1;
    const chain = (r: NoteRec) => { r.longPressPTick = spec.startTick; r.endIndex = endIndex; r.longPressNum = count; return r; };

    out.push(chain(makeNote(tpl, startIndex, spec.startTick, length, spec)));
    for (let i = 1; i <= middles; i++) {
        const m = chain(makeNote(tpl, out.length, spec.startTick + LONG_MIDDLE_STEP * i, 0, spec));
        m.isLongPressing = true;
        out.push(m);
    }
    const end = chain(makeNote(tpl, out.length, spec.startTick + length, 0, spec));
    end.isLongPressEnd = true;
    out.push(end);
}

// ---- PC ApplyBmsDoubleState: 같은 tick의 지상·공중 일반 노트를 동시치기 짝으로 ----
function applyDoubleState(notes: NoteRec[]): number {
    const groups = new Map<number, number[]>();
    for (let i = 1; i < notes.length; i++) {
        const key = Math.round(notes[i].tick * 1000);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(i);
    }
    let pairs = 0;
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const road: number[] = [], air: number[] = [];
        for (const i of group) {
            const n = notes[i];
            if (n.type !== NoteTypes.Normal || n.isLongPressing || n.isLongPressEnd) continue;
            (n.pathway === 1 ? air : road).push(i);
        }
        for (let k = 0; k < Math.min(road.length, air.length); k++) {
            const a = notes[road[k]], b = notes[air[k]];
            a.isDouble = true; a.doubleIdx = b.objId;
            b.isDouble = true; b.doubleIdx = a.objId;
            pairs++;
        }
    }
    return pairs;
}

// ---- PC SortBmsNotesByShowTick: showTick → tick → objId 정렬 후 endIndex/doubleIdx 재연결 ----
function sortByShowTick(notes: NoteRec[]): NoteRec[] {
    const head = notes[0];
    const body = notes.slice(1).sort((l, r) => l.showTick - r.showTick || l.tick - r.tick || l.objId - r.objId);
    const newIndex = new Map<number, number>();
    body.forEach((n, i) => newIndex.set(n.objId, i + 1));
    for (const n of body) {
        const oldDouble = n.doubleIdx;
        const oldEnd = n.endIndex;
        n.doubleIdx = n.type === NoteTypes.Boss ? -1 : 0;
        if (n.isDouble && newIndex.has(oldDouble)) n.doubleIdx = newIndex.get(oldDouble)!;
        if (isSceneToggle(n)) n.doubleIdx = -1;
        if (oldEnd > 0 && newIndex.has(oldEnd)) n.endIndex = newIndex.get(oldEnd)!;
        n.objId = newIndex.get(n.objId)!;
    }
    return [head, ...body];
}

function writeStr(p: NativePointer, text: string | null): void {
    p.writePointer(text === null ? NULL : pinnedString(text));
}

function serialize(dst: NativePointer, r: NoteRec): void {
    if (r.official) Memory.copy(dst.add(MD.note), r.official, NOTE_CONFIG_SIZE);
    const note = dst.add(MD.note);
    const cfg = dst.add(MD.cfg);
    dst.add(MD.objId).writeS16(r.objId);
    writeDecimal(dst.add(MD.tick), r.tick);
    writeDecimal(dst.add(MD.dt), r.dt);
    writeDecimal(dst.add(MD.showTick), r.showTick);
    dst.add(MD.isLongPressing).writeU8(r.isLongPressing ? 1 : 0);
    dst.add(MD.isLongPressEnd).writeU8(r.isLongPressEnd ? 1 : 0);
    writeDecimal(dst.add(MD.longPressPTick), r.longPressPTick);
    dst.add(MD.endIndex).writeS32(r.endIndex);
    dst.add(MD.longPressNum).writeS32(r.longPressNum);
    dst.add(MD.isDouble).writeU8(r.isDouble ? 1 : 0);
    dst.add(MD.doubleIdx).writeS32(r.doubleIdx);

    writeStr(note.add(NC.id), String(r.objId));
    writeStr(note.add(NC.uid), r.uid);
    writeStr(note.add(NC.mirror_uid), r.uid);
    if (r.ibmsId) writeStr(note.add(NC.ibms_id), r.ibmsId);
    note.add(NC.type).writeU32(r.type);
    note.add(NC.pathway).writeS32(r.pathway);
    if (r.isShowPlayEffect !== null) note.add(NC.isShowPlayEffect).writeU8(r.isShowPlayEffect ? 1 : 0);
    if (r.effect !== null) writeStr(note.add(NC.effect), r.effect);
    if (r.noteUid !== null) note.add(NC.noteUid).writeS32(r.noteUid);
    if (r.scene) writeStr(note.add(NC.scene), r.scene);
    note.add(NC.sceneChangeNames).writePointer(NULL);
    if (r.prefab !== null) writeStr(note.add(NC.prefab_name), r.prefab);
    if (r.keyAudio !== null) writeStr(note.add(NC.key_audio), r.keyAudio);
    if (r.bossAction) writeStr(note.add(NC.boss_action), r.bossAction);
    if (r.speed !== null) note.add(NC.speed).writeS32(r.speed);

    cfg.add(CFG.id).writeS32(r.objId);
    writeDecimal(cfg.add(CFG.time), r.cfgTime);
    writeDecimal(cfg.add(CFG.length), r.cfgLength);
    if (r.uid) {
        writeStr(cfg.add(CFG.note_uid), r.uid);
        cfg.add(CFG.pathway).writeS32(r.pathway);
    }
}

/** 정확도 분모용 노트 종류별 개수 (PC DBStageInfoExperimentChart.RecountNoteTypes). 롱노트는 머리·꼬리만, 보스·씬 전환은 제외. */
export interface NoteCounts { standard: number; gears: number; hearts: number; blue: number; }
export let lastCounts: NoteCounts = { standard: 0, gears: 0, hearts: 0, blue: 0 };

function recount(notes: NoteRec[]): NoteCounts {
    const c: NoteCounts = { standard: 0, gears: 0, hearts: 0, blue: 0 };
    for (const n of notes.slice(1)) {
        if (n.type === NoteTypes.Boss || isSceneToggle(n)) continue;
        if (n.type === NoteTypes.Gear) c.gears++;
        else if (n.type === NoteTypes.Heart || n.uid.startsWith("0002")) c.hearts++;
        else if (n.type === NoteTypes.Blue || n.uid.startsWith("0003")) c.blue++;
        else if (n.type === NoteTypes.Long) { if (!n.isLongPressing) c.standard++; }
        else c.standard++;
    }
    return c;
}

/** 노트 목록을 BMS 차트로 바꾼다. 실패하면 원본을 그대로 둔다. 마지막 노트 끝 시각(초)을 돌려준다(실패 0). */
export function injectChart(list: NativePointer, song: HwaSong, musicDataClass: Il2Cpp.Class): number {
    const elemSize = musicDataClass.valueTypeSize;
    const items = list.add(LIST_ITEMS).readPointer();
    const size = list.add(LIST_SIZE).readS32();
    if (items.isNull() || size < 2) {
        log({ t: "chart-skip", reason: "원본 노트 부족", size });
        return 0;
    }
    const src = items.add(ARRAY_DATA);
    const anchor = Memory.alloc(elemSize);
    Memory.copy(anchor, src, elemSize);
    const tplBytes = Memory.alloc(elemSize);
    Memory.copy(tplBytes, src.add(elemSize), elemSize);
    const tpl: Template = {
        bytes: tplBytes,
        type: tplBytes.add(MD.note + NC.type).readU32(),
        pathway: tplBytes.add(MD.note + NC.pathway).readS32(),
        effect: readIl2CppString(tplBytes.add(MD.note + NC.effect).readPointer())
    };

    const build = buildSpecsFromBms(song.chart, song.manifest.scene, song.manifest.fixDtToRecommended === true);
    if (build.specs.length === 0) {
        log({ t: "chart-skip", reason: "변환된 노트 없음", song: song.name });
        return 0;
    }

    const anchorRec = { official: null, objId: 0 } as unknown as NoteRec;
    let notes: NoteRec[] = [anchorRec];
    for (const spec of build.specs) addSpec(notes, tpl, spec);
    if (notes.length > SHORT_MAX) {
        log({ t: "chart-skip", reason: `노트 ${notes.length}개가 objId(short) 상한 초과`, song: song.name });
        return 0;
    }
    const pairs = applyDoubleState(notes);
    notes = sortByShowTick(notes);

    const array = Il2Cpp.array(musicDataClass, notes.length);
    array.object.ref(true);
    const data = array.handle.add(ARRAY_DATA);
    Memory.copy(data, anchor, elemSize);
    for (let i = 1; i < notes.length; i++) {
        const dst = data.add(i * elemSize);
        Memory.copy(dst, tplBytes, elemSize);
        serialize(dst, notes[i]);
    }
    list.add(LIST_ITEMS).writePointer(array.handle);
    list.add(LIST_SIZE).writeS32(notes.length);
    list.add(LIST_VERSION).writeS32(list.add(LIST_VERSION).readS32() + 1);

    lastCounts = recount(notes);
    const counts: Record<number, number> = {};
    for (const n of notes.slice(1)) counts[n.type] = (counts[n.type] ?? 0) + 1;
    log({
        t: "chart-injected", song: song.name, original: size, notes: notes.length, specs: build.specs.length,
        holdSandbagPairs: build.pairs, doublePairs: pairs, accuracyCounts: lastCounts, dtChanged: build.dtChanged, byType: counts,
        warnings: build.warnings.slice(0, 10), elemSize,
        first: notes.slice(1, 4).map(n => ({ uid: n.uid, type: n.type, tick: n.tick, dt: n.dt, showTick: n.showTick, prefab: n.prefab }))
    });
    let end = 0;
    for (const n of notes.slice(1)) end = Math.max(end, n.tick + Math.max(0, n.cfgLength));
    return end;
}

export function readListSample(list: NativePointer, count: number, elemSize: number): object[] {
    const items = list.add(LIST_ITEMS).readPointer().add(ARRAY_DATA);
    const out: object[] = [];
    for (let i = 0; i < count; i++) {
        const p = items.add(i * elemSize);
        out.push({
            objId: p.add(MD.objId).readS16(), tick: readDecimal(p.add(MD.tick)), dt: readDecimal(p.add(MD.dt)),
            showTick: readDecimal(p.add(MD.showTick)), uid: readIl2CppString(p.add(MD.note + NC.uid).readPointer()),
            type: p.add(MD.note + NC.type).readU32(), prefab: readIl2CppString(p.add(MD.note + NC.prefab_name).readPointer())
        });
    }
    return out;
}

export const DB_STAGE_INFO_MUSIC_LIST = DBSTAGEINFO_MUSICLIST;
