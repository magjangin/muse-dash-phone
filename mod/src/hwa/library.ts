// 기기의 곡 폴더 목록: <앱 files>/hwa/<곡>/ 에서 info txt, BMS, music.ogg, cover.png 를 찾는다.
// PC 모드 HwaResourceManager(.Bms) + HwaManifestLoader의 파일 선택 규칙 이식본.
import { MOD_DIR, log } from "../log.js";
import { listDir, readText } from "../native.js";
import { parseBms } from "../bms/parser.js";
import type { BmsChart } from "../bms/parser.js";
import { parseManifest } from "./manifest.js";
import type { HwaManifest } from "./manifest.js";

export const HWA_DIR = `${MOD_DIR}/hwa`;

// 커스텀 태그·앨범·가상 곡 식별자 (PC 모드 Core/CustomContentIds.cs). 앨범이 1999-0이라 곡은 1999-1부터.
export const TAG_INDEX = 1999;
export const TAG_UID = "tag-muse-dash-test";
export const ALBUM_UID = "1999-0";
export const VIRTUAL_PREFIX = "1999-";
export const FALLBACK_HOST_UID = "0-0";

export interface HwaSong {
    virtualUid: string;     // 1999-N (폴더 정렬 순서)
    folder: string;
    name: string;
    manifest: HwaManifest;
    chart: BmsChart;
    musicPath: string | null;
    coverPath: string | null;
    videoPath: string | null;
}

/** 편집기·동기화 도구 임시본만 거른다(tempo.bms 같은 정상 채보는 남긴다). PC BmsFileNames.IsTempFile 이식. */
export function isTempFile(fileName: string): boolean {
    if (!fileName.trim()) return true;
    if (fileName.startsWith("~") || fileName.startsWith("___") || fileName.startsWith(".")) return true;
    if (fileName.endsWith("~")) return true;
    const base = fileName.replace(/\.[^.]*$/, "");
    if (!base.trim()) return true;
    for (const word of ["temp", "tmp"]) {
        const lower = base.toLowerCase();
        if (lower === word) return true;
        if (lower.length > word.length && lower.startsWith(word) && !/\p{L}/u.test(base[word.length])) return true;
    }
    return false;
}

function pickManifest(names: string[]): string | null {
    const txt = names.filter(n => n.toLowerCase().endsWith(".txt")).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return txt.find(n => /^info1?\.txt$/i.test(n)) ?? txt[0] ?? null;
}

function pickBms(names: string[]): string | null {
    const bms = names.filter(n => /\.bms$/i.test(n) && !isTempFile(n)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return bms.find(n => /^(chart|main|test)\.bms$/i.test(n)) ?? bms[0] ?? null;
}

function pickFile(names: string[], pattern: RegExp): string | null {
    return names.find(n => pattern.test(n)) ?? null;
}

let songs: HwaSong[] = [];

export function loadLibrary(): HwaSong[] {
    songs = [];
    for (const entry of listDir(HWA_DIR)) {
        if (!entry.isDir) continue;
        const folder = `${HWA_DIR}/${entry.name}`;
        try {
            const files = listDir(folder).filter(e => !e.isDir).map(e => e.name);
            const manifestName = pickManifest(files);
            const bmsName = pickBms(files);
            if (!manifestName || !bmsName) {
                log({ t: "hwa-skip", folder: entry.name, manifest: manifestName, bms: bmsName });
                continue;
            }
            const manifest = parseManifest(readText(`${folder}/${manifestName}`), `${folder}/${manifestName}`);
            const chart = parseBms(readText(`${folder}/${bmsName}`), `${folder}/${bmsName}`);
            const music = pickFile(files, /^music\.(ogg|wav|mp3)$/i) ?? pickFile(files, /\.ogg$/i);
            const cover = pickFile(files, /^cover\.(png|jpg|jpeg)$/i);
            const video = pickFile(files, /^(video|bga|bg|movie)\.mp4$/i) ?? pickFile(files, /\.mp4$/i);
            const song: HwaSong = {
                virtualUid: `${VIRTUAL_PREFIX}${songs.length + 1}`,
                folder, name: entry.name, manifest, chart,
                musicPath: music ? `${folder}/${music}` : null,
                coverPath: cover ? `${folder}/${cover}` : null,
                videoPath: video ? `${folder}/${video}` : null
            };
            songs.push(song);
            log({
                t: "hwa-song", folder: entry.name, virtualUid: song.virtualUid, hostUid: manifest.uid, title: manifest.customTitle ?? manifest.title,
                bms: bmsName, notes: chart.notes.length, bpm: chart.defaultBpm, music, cover,
                unknownKeys: manifest.unknownKeys, warnings: chart.warnings
            });
        } catch (e) {
            log({ t: "hwa-error", folder: entry.name, error: `${e}` });
        }
    }
    log({ t: "hwa-library", count: songs.length });
    return songs;
}

/** info.txt를 다시 읽는다 (차트는 그대로). 실패하면 이전 값을 유지. */
export function reloadManifest(song: HwaSong): void {
    try {
        song.manifest = parseManifest(readText(song.manifest.sourcePath), song.manifest.sourcePath);
    } catch (e) {
        log({ t: "manifest-reload-error", song: song.name, error: `${e}` });
    }
}

/** 가상 곡 uid(1999-N) → 곡 폴더. 순정 곡 uid면 null(순정 곡 차트는 건드리지 않는다). */
export function songForUid(uid: string | null): HwaSong | null {
    if (!uid || !uid.startsWith(VIRTUAL_PREFIX) || uid === ALBUM_UID) return null;
    return songs.find(s => s.virtualUid === uid) ?? null;
}

export function allSongs(): HwaSong[] {
    return songs;
}
