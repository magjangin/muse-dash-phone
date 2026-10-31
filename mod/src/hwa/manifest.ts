// 곡 폴더의 info.txt(`hwa info.txt` 등) 파서. PC 모드 Patches/Hwa/HwaManifestLoader.cs + HwaManifest.cs 이식본.
// 키는 공백·기호를 빼고 소문자로 만든 뒤 "포함" 규칙으로 고른다(예: "내가 가져올 uid" → uid). 판정 순서가 의미를 가진다.

export interface HwaManifest {
    sourcePath: string;
    uid?: string;              // 숙주(복제 원본) 곡 uid, 예 "0-4"
    title?: string;
    customTitle?: string;
    artist?: string;
    customArtist?: string;
    levelDesigner?: string;
    album?: string;
    scene?: number | null;
    difficulty1?: number | null;
    difficulty2?: number | null;
    difficulty3?: number | null;
    difficulty4?: number | null;
    difficulty5?: number | null;
    delay?: number | null;
    /** Android 전용 음악 delay. PC 'delay'는 PC 스트리밍 재생 경로에 맞춘 보정값이라 Android에선 기본으로 안 쓴다(아래 apply 참고). */
    androidDelay?: number | null;
    offset?: number | null;
    showGhostNotes?: boolean | null;
    fixDtToRecommended?: boolean | null;
    autoPlay?: boolean | null;
    cinema?: boolean | null;
    blockFever?: boolean | null;
    unknownKeys: string[];
}

export function parseManifest(text: string, sourcePath: string): HwaManifest {
    const m: HwaManifest = { sourcePath, unknownKeys: [] };
    for (const raw of text.split(/\r?\n/)) {
        const kv = parseLine(raw);
        if (kv) apply(m, kv[0], kv[1]);
    }
    return m;
}

function parseLine(raw: string): [string, string] | null {
    let line = raw.replace(/^﻿/, "").trim();
    if (!line || line.startsWith("//")) return null;
    line = stripTrailingComment(line);
    if (!line) return null;
    const at = line.search(/[:=：]/);
    if (at < 0) return null;
    const key = line.substring(0, at).trim();
    const value = line.substring(at + 1).trim();
    return key && value ? [key, value] : null;
}

/** 앞에 공백이 있는 '//'부터 자른다(값 안의 URL 등 '//'는 보존). */
function stripTrailingComment(line: string): string {
    for (let i = 1; i < line.length - 1; i++) {
        if (line[i] === "/" && line[i + 1] === "/" && /\s/.test(line[i - 1])) return line.substring(0, i).trimEnd();
    }
    return line;
}

export function normalizeKey(text: string): string {
    let out = "";
    for (const ch of text) {
        if (/\s/.test(ch) || "-_/·.()[]".includes(ch)) continue;
        out += ch.toLowerCase();
    }
    return out;
}

const has = (key: string, tokens: string[]) => tokens.some(t => key.includes(t));

function parseNullableInt(v: string): number | null {
    if (!v || v.trim().toLowerCase() === "null") return null;
    const n = parseInt(v.trim(), 10);
    return isNaN(n) || !/^[+-]?\d+$/.test(v.trim()) ? null : n;
}

function parseNullableDouble(v: string): number | null {
    if (!v || v.trim().toLowerCase() === "null") return null;
    const n = parseFloat(v.trim());
    return isNaN(n) ? null : n;
}

function parseNullableBool(v: string): boolean | null {
    switch (normalizeKey(v)) {
        case "활성화": case "켜기": case "켜짐": case "true": case "on": case "yes": case "1": return true;
        case "비활성화": case "끄기": case "끔": case "false": case "off": case "no": case "0": return false;
        default: return null;
    }
}

function apply(m: HwaManifest, rawKey: string, value: string): void {
    const k = normalizeKey(rawKey);
    if (has(k, ["고스트노트보이기", "고스트보이기", "노트보이기", "ghostnote"])) { m.showGhostNotes = parseNullableBool(value); return; }
    if (has(k, ["오토플레이", "오토", "autoplay", "auto"])) { m.autoPlay = parseNullableBool(value); return; }
    if (has(k, ["시네마", "bga", "video", "cinema", "배경영상"])) { m.cinema = parseNullableBool(value); return; }
    if (has(k, ["피버충전금지", "피버차단", "피버금지", "blockfever", "nofever"])) { m.blockFever = parseNullableBool(value); return; }
    if (has(k, ["권장표", "권장dt", "dt보정", "recommendeddt", "fixdt"])) { m.fixDtToRecommended = parseNullableBool(value); return; }
    if (has(k, ["가져올앨범", "앨범", "album"])) { m.album = value; return; }
    if (has(k, ["uid"])) { m.uid = value; return; }
    if (has(k, ["커스텀아티스트", "customartist", "customauthor"])) { m.customArtist = value; return; }
    if (has(k, ["레벨디자이너", "leveldesigner"])) { m.levelDesigner = value; return; }
    if (has(k, ["artist", "아티스트", "author"])) { m.artist = value; return; }
    if (has(k, ["커스텀곡제목", "커스텀곡이름", "커스텀곡명", "customsongtitle", "customsongname", "customtitle"])) { m.customTitle = value; return; }
    if (has(k, ["곡이름", "곡명", "곡제목", "가져올곡", "song", "title", "music"])) { m.title = value; return; }
    if (has(k, ["씬번호", "scene"])) { m.scene = parseNullableInt(value); return; }
    if (has(k, ["난이도1", "difficulty1"])) { m.difficulty1 = parseNullableInt(value); return; }
    if (has(k, ["난이도2", "difficulty2"])) { m.difficulty2 = parseNullableInt(value); return; }
    if (has(k, ["난이도3", "difficulty3"])) { m.difficulty3 = parseNullableInt(value); return; }
    if (has(k, ["난이도4", "difficulty4"])) { m.difficulty4 = parseNullableInt(value); return; }
    if (has(k, ["난이도5", "difficulty5"])) { m.difficulty5 = parseNullableInt(value); return; }
    // 'android delay'/'안드로이드 delay'가 그냥 delay보다 먼저 걸려야 한다(키에 delay가 들어 있음).
    if (has(k, ["androiddelay", "안드로이드delay", "안드로이드지연"])) { m.androidDelay = parseNullableDouble(value); return; }
    if (has(k, ["delay", "지연"])) { m.delay = parseNullableDouble(value); return; }
    if (has(k, ["offset", "오프셋", "싱크"])) { m.offset = parseNullableDouble(value); return; }
    m.unknownKeys.push(rawKey);
}
