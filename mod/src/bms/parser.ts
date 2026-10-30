// BMS 텍스트 → BmsChart. PC 모드 Bms/BmsParser.cs + BmsParser.Lexer.cs + BmsModels.cs 의 이식본(동작 동일 유지).
// 시간 = tick × 4 × 60 / bpm (tick = 마디 + 셀/셀수). BPM 변경은 '#BPMxx nnn' 선언 + 채널 08만 지원(채널 03은 경고 후 무시).

export const BmsLane = {
    Note: 0,
    BossInOut: 2,   // 보스 등장/퇴장
    BossAction: 3,  // 보스 액션/패턴
    Unknown: -1
} as const;
export type BmsLane = typeof BmsLane[keyof typeof BmsLane];

export interface BmsNote {
    measure: number;
    channel: number;
    cellIndex: number;
    lane: BmsLane;
    rawValue: string;
    tick: number;
    time: number;
}

export interface BpmChange {
    tick: number;
    bpm: number;
    source: string;
    // 같은 틱에 여러 변경이 모였을 때의 적용 순서(작을수록 먼저). 기본 BPM이 0번.
    order: number;
}

export interface BmsChart {
    sourcePath: string | null;
    title?: string;
    artist?: string;
    defaultBpm: number;
    bpmDefinitions: Map<string, number>;
    /** 키는 대문자로 저장한다(PC판 OrdinalIgnoreCase 사전과 같게). */
    metadata: Map<string, string>;
    bpmChanges: BpmChange[];
    notes: BmsNote[];
    warnings: string[];
}

const CHANNEL_TO_LANE = new Map<number, BmsLane>([
    [0x13, BmsLane.Note],
    [0x14, BmsLane.Note],
    [0x15, BmsLane.BossInOut],
    [0x18, BmsLane.BossAction]
]);

const HEADER_BPM = /^#BPM\s+([0-9]+(?:\.[0-9]+)?)\s*$/i;
// 표준 BMS는 "#BPM01 240"처럼 공백으로 값을 적는다. ':'/'=' 구분도 받는다.
const BPM_ALIAS = /^#BPM([0-9A-Fa-f]{2})(?:\s*[:=]\s*|\s+)([0-9]+(?:\.[0-9]+)?)\s*$/i;
const MEASURE_LINE = /^#(\d{3})([0-9A-Fa-f]{2})\s*:\s*([0-9A-Za-z\s]+)$/i;
const METADATA = /^#([A-Za-z0-9_]+)\s+(.+)$/;

interface RawMeasureEvent { measure: number; channel: number; data: string; }

export function parseBms(text: string, sourcePath: string | null = null): BmsChart {
    const chart: BmsChart = {
        sourcePath, defaultBpm: 120, bpmDefinitions: new Map(), metadata: new Map(),
        bpmChanges: [], notes: [], warnings: []
    };
    if (!text || text.trim().length === 0) return chart;

    const events: RawMeasureEvent[] = [];
    let defaultBpm = 120;
    let sawNonPositiveHeaderBpm = false;

    for (const rawLine of text.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (trimmed.length === 0 || isCommentLine(trimmed)) continue;

        // 마디·BPM 줄은 뒤 주석을 떼고 읽는다. 곡 정보는 자유 텍스트라 떼지 않은 줄을 쓴다.
        const line = stripComments(trimmed).trim();

        let m = MEASURE_LINE.exec(line);
        if (m && m[3].trim().length > 0) {
            events.push({ measure: parseInt(m[1], 10), channel: parseInt(m[2], 16), data: normalizeHexData(m[3]) });
            continue;
        }
        m = HEADER_BPM.exec(line);
        if (m) {
            const bpm = parseFloat(m[1]);
            // #BPM 0을 받으면 60/0으로 모든 노트 시간이 무한대가 된다.
            if (bpm > 0) defaultBpm = bpm; else sawNonPositiveHeaderBpm = true;
            continue;
        }
        m = BPM_ALIAS.exec(line);
        if (m) {
            chart.bpmDefinitions.set(m[1].toUpperCase(), parseFloat(m[2]));
            continue;
        }
        if (trimmed.startsWith("#")) {
            m = METADATA.exec(trimmed);
            if (m) {
                const key = m[1].trim().toUpperCase();
                const value = m[2].trim();
                if (key && value) {
                    chart.metadata.set(key, value);
                    if (key === "TITLE") chart.title = value;
                    else if (key === "ARTIST") chart.artist = value;
                }
            }
        }
    }

    chart.defaultBpm = defaultBpm;
    const noteCellWidth = detectWavCellWidth(chart.metadata);
    const bpmChanges: BpmChange[] = [{ tick: 0, bpm: defaultBpm, source: "default", order: 0 }];

    let sawDirectBpmChannel = false;
    for (const evt of events) {
        if (evt.channel === 0x08) addBpmReferenceChanges(evt, chart.bpmDefinitions, bpmChanges);
        else if (evt.channel === 0x03) sawDirectBpmChannel = true;
    }
    if (sawDirectBpmChannel) {
        chart.warnings.push(`채널 03(직접 BPM 변경)은 지원하지 않아 무시했습니다: ${sourcePath ?? "(경로 없음)"}. '#BPMxx nnn' 선언과 채널 08로 적어 주세요.`);
    }
    if (sawNonPositiveHeaderBpm) {
        chart.warnings.push(`0 이하인 #BPM 줄을 무시했습니다 (적용 BPM: ${defaultBpm}): ${sourcePath ?? "(경로 없음)"}.`);
    }

    const notes: BmsNote[] = [];
    for (const evt of events) {
        const lane = CHANNEL_TO_LANE.get(evt.channel);
        if (lane === undefined) continue;
        addNoteEvents(evt, lane, notes, noteCellWidth);
    }

    // 같은 틱이면 선언 순서대로(기본 BPM이 항상 첫 항목).
    bpmChanges.sort((l, r) => l.tick - r.tick || l.order - r.order);
    notes.sort((l, r) => l.tick - r.tick || l.channel - r.channel);

    // 한 번 훑어 모든 노트 시간을 계산한다.
    let time = 0;
    let currentTick = 0;
    let currentBpm = bpmChanges[0].bpm > 0 ? bpmChanges[0].bpm : defaultBpm;
    let bpmIndex = 0;
    for (const note of notes) {
        while (bpmIndex < bpmChanges.length) {
            const change = bpmChanges[bpmIndex];
            if (change.tick > note.tick) break;
            if (change.tick > currentTick) {
                time += (change.tick - currentTick) * 4 * (60 / currentBpm);
                currentTick = change.tick;
            }
            currentBpm = change.bpm > 0 ? change.bpm : currentBpm;
            bpmIndex++;
        }
        let noteTime = time;
        if (note.tick > currentTick) noteTime += (note.tick - currentTick) * 4 * (60 / currentBpm);
        note.time = noteTime;
    }

    chart.bpmChanges = bpmChanges;
    chart.notes = notes;
    return chart;
}

export function calculateTime(tick: number, bpmChanges: BpmChange[]): number {
    if (!bpmChanges || bpmChanges.length === 0) return tick * 4 * (60 / 120);
    let time = 0;
    let currentTick = 0;
    let currentBpm = bpmChanges[0].bpm <= 0 ? 120 : bpmChanges[0].bpm;
    for (const change of bpmChanges) {
        if (change.tick <= currentTick) {
            currentBpm = change.bpm > 0 ? change.bpm : currentBpm;
            continue;
        }
        if (change.tick > tick) break;
        time += (change.tick - currentTick) * 4 * (60 / currentBpm);
        currentTick = change.tick;
        currentBpm = change.bpm > 0 ? change.bpm : currentBpm;
    }
    if (tick > currentTick) time += (tick - currentTick) * 4 * (60 / currentBpm);
    return time;
}

function addBpmReferenceChanges(evt: RawMeasureEvent, defs: Map<string, number>, out: BpmChange[]): void {
    const width = 2;
    const cellCount = getCellCount(evt.data, width);
    for (let i = 0; i < cellCount; i++) {
        const offset = i * width;
        if (isZeroCell(evt.data, offset, width)) continue;
        const cell = evt.data.substr(offset, width);
        const bpm = defs.get(cell);
        if (bpm === undefined) continue;
        out.push({ tick: evt.measure + i / cellCount, bpm, source: `BPM${cell}`, order: out.length });
    }
}

function addNoteEvents(evt: RawMeasureEvent, lane: BmsLane, out: BmsNote[], cellWidth: number): void {
    const width = Math.max(2, cellWidth);
    const cellCount = getCellCount(evt.data, width);
    for (let i = 0; i < cellCount; i++) {
        const offset = i * width;
        if (isZeroCell(evt.data, offset, width)) continue;
        out.push({
            measure: evt.measure, channel: evt.channel, cellIndex: i, lane,
            rawValue: evt.data.substr(offset, width), tick: evt.measure + i / cellCount, time: 0
        });
    }
}

function getCellCount(data: string, cellWidth: number): number {
    if (!data || data.trim().length === 0) return 0;
    return Math.floor(data.length / Math.max(2, cellWidth));
}

function detectWavCellWidth(metadata: Map<string, string>): number {
    let width = 2;
    for (const key of metadata.keys()) {
        if (!key.startsWith("WAV")) continue;
        const raw = key.substring(3);
        if (raw.length > width) width = raw.length;
    }
    return width;
}

function isZeroCell(data: string, offset: number, width: number): boolean {
    for (let i = offset; i < offset + width; i++) if (data[i] !== "0") return false;
    return true;
}

function normalizeHexData(data: string): string {
    let out = "";
    for (const ch of data) if (/[0-9A-Za-z]/.test(ch)) out += ch.toUpperCase();
    return out;
}

function isCommentLine(trimmed: string): boolean {
    return trimmed.startsWith("//") || trimmed.startsWith(";");
}

/** 줄 뒤 '//' 또는 ';' 주석을 먼저 나온 쪽에서 자른다. 마디·BPM 줄에만 쓴다. */
function stripComments(line: string): string {
    const slash = line.indexOf("//");
    const semi = line.indexOf(";");
    const at = slash < 0 ? semi : (semi < 0 ? slash : Math.min(slash, semi));
    return at >= 0 ? line.substring(0, at) : line;
}
