// 기기의 곡 폴더 목록: <앱 files>/hwa/<곡>/ 및 /storage/emulated/0/MuseDash/hwa/<곡>/ 에서 info txt, BMS, music.ogg, cover.png 를 찾는다.
// PC 모드 HwaResourceManager(.Bms) + HwaManifestLoader의 파일 선택 규칙 이식본.
import { MOD_DIR, log } from "../log.js";
import { listDir, readText } from "../native.js";
import { parseBms } from "../bms/parser.js";
import type { BmsChart } from "../bms/parser.js";
import { pickDefaultBms, resolveChartName } from "./chartFiles.js";
import { parseManifest } from "./manifest.js";
import { pullFromAssistant } from "./assistant.js";
import type { HwaManifest } from "./manifest.js";

export const PUBLIC_HWA_DIR = "/storage/emulated/0/MuseDash/hwa";
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
    chart: BmsChart;        // 기본 채보. 난이도에 맞는 채보는 chartForDifficulty로 얻는다.
    fileNames: string[];    // 폴더 바로 아래 파일 이름들 (난이도별 채보 이름 찾기용)
    difficultyCharts: Map<string, BmsChart | null>;   // 'info.txt 값 → 읽은 채보'. 처음 쓸 때 읽어 시작 시간을 늘리지 않는다. null은 못 씀
    hostMaps: number[];     // 숙주 곡에 실제로 있는 난이도 번호. 가상 곡을 만들 때 채운다(customTag.ts).
    musicPath: string | null;
    coverPath: string | null;
    videoPath: string | null;
}

function pickManifest(names: string[]): string | null {
    const txt = names.filter(n => n.toLowerCase().endsWith(".txt")).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return txt.find(n => /^info1?\.txt$/i.test(n)) ?? txt[0] ?? null;
}

function pickFile(names: string[], pattern: RegExp): string | null {
    return names.find(n => pattern.test(n)) ?? null;
}

let songs: HwaSong[] = [];

export function loadLibrary(): HwaSong[] {
    songs = [];
    // 비서 앱이 받은 곡을 먼저 앱 고유 폴더로 가져온다 (실패해도 기존 곡으로 계속).
    try {
        pullFromAssistant(HWA_DIR);
    } catch (e) {
        log({ t: "assistant-sync-error", error: `${e}` });
    }
    const seenFolders = new Set<string>();
    // 앱 고유 폴더(HWA_DIR)는 권한 제한 없이 100% 읽기 가능하므로 우선 탐색
    const searchDirs = [HWA_DIR, PUBLIC_HWA_DIR];

    for (const baseDir of searchDirs) {
        for (const entry of listDir(baseDir)) {
            if (!entry.isDir) continue;
            if (seenFolders.has(entry.name)) continue;
            const folder = `${baseDir}/${entry.name}`;
            try {
                const files = listDir(folder).filter(e => !e.isDir).map(e => e.name);
                const manifestName = pickManifest(files);
                if (!manifestName) {
                    log({ t: "hwa-skip", folder: entry.name, manifest: manifestName, bms: pickDefaultBms(files), dir: baseDir });
                    continue;
                }
                const manifest = parseManifest(readText(`${folder}/${manifestName}`), `${folder}/${manifestName}`);
                const claimed = manifest.difficultyBmsFiles.filter((f): f is string => !!f);
                const bmsName = pickDefaultBms(files, claimed);
                if (!bmsName) {
                    log({ t: "hwa-skip", folder: entry.name, manifest: manifestName, bms: bmsName, dir: baseDir });
                    continue;
                }
                const chart = parseBms(readText(`${folder}/${bmsName}`), `${folder}/${bmsName}`);
                const music = pickFile(files, /^music\.(ogg|wav|mp3)$/i) ?? pickFile(files, /\.ogg$/i);
                const cover = pickFile(files, /^cover\.(png|jpg|jpeg)$/i);
                const video = pickFile(files, /^(video|bga|bg|movie)\.mp4$/i) ?? pickFile(files, /\.mp4$/i);
                const song: HwaSong = {
                    virtualUid: `${VIRTUAL_PREFIX}${songs.length + 1}`,
                    folder, name: entry.name, manifest, chart,
                    fileNames: files, difficultyCharts: new Map(), hostMaps: [],
                    musicPath: music ? `${folder}/${music}` : null,
                    coverPath: cover ? `${folder}/${cover}` : null,
                    videoPath: video ? `${folder}/${video}` : null
                };
                songs.push(song);
                seenFolders.add(entry.name);
                log({
                    t: "hwa-song", folder: entry.name, virtualUid: song.virtualUid, hostUid: manifest.uid, title: manifest.customTitle ?? manifest.title,
                    bms: bmsName, difficultyBms: claimed, notes: chart.notes.length, bpm: chart.defaultBpm, music, cover,
                    unknownKeys: manifest.unknownKeys, warnings: chart.warnings, dir: baseDir
                });
            } catch (e) {
                log({ t: "hwa-error", folder: entry.name, error: `${e}`, dir: baseDir });
            }
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

/**
 * 이 곡의 이 난이도에서 쓸 채보. info.txt에 '난이도N bms'가 없는 난이도는 기본 채보를 쓴다.
 * 값이 잘못됐거나 파일을 못 읽으면 이유를 한 번 남기고 기본 채보로 대신한다(배틀은 계속된다).
 */
export function chartForDifficulty(song: HwaSong, difficulty: number): BmsChart {
    const configured = song.manifest.difficultyBmsFiles[difficulty];
    if (!configured) return song.chart;

    let chart = song.difficultyCharts.get(configured);
    if (chart === undefined) {
        chart = loadDifficultyChart(song, difficulty, configured);
        song.difficultyCharts.set(configured, chart);
    }
    return chart ?? song.chart;
}

function loadDifficultyChart(song: HwaSong, difficulty: number, configured: string): BmsChart | null {
    const name = resolveChartName(configured, song.fileNames);
    if (!name) {
        log({ t: "hwa-difficulty-bms-invalid", song: song.name, difficulty, configured, reason: "곡 폴더 안의 .bms 파일이어야 합니다" });
        return null;
    }
    const path = `${song.folder}/${name}`;
    if (path === song.chart.sourcePath) return song.chart;
    try {
        const chart = parseBms(readText(path), path);
        log({ t: "hwa-difficulty-bms", song: song.name, difficulty, bms: name, notes: chart.notes.length, warnings: chart.warnings });
        return chart;
    } catch (e) {
        log({ t: "hwa-difficulty-bms-error", song: song.name, difficulty, bms: name, error: `${e}` });
        return null;
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
