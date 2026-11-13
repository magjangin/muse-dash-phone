// 커스텀 Spine 스킨 세트 파일 찾기·검사 (spineSkin.ts에서 분리, 2026-11-13).
// 배치: <앱 files>/skin test/{character|note}/{세트}/{세트}.json·.atlas·.png. 옛 배치 skin test/{세트}/도 읽는다.
import { MOD_DIR } from "../log.js";
import { fileExists, regularFileSize } from "../native.js";

export const SKIN_ROOT = `${MOD_DIR}/skin test`;

const SKELETON_DATA_SUFFIX = "_SkeletonData";

export type Kind = "character" | "note";

// ---- 파일 ----
export function setDir(kind: Kind, base: string): string {
    const preferred = `${SKIN_ROOT}/${kind}/${base}`;
    if (fileExists(`${preferred}/${base}.json`)) return preferred;
    const legacy = `${SKIN_ROOT}/${base}`;
    return fileExists(`${legacy}/${base}.json`) ? legacy : preferred;
}

/** 아틀라스 첫 페이지 줄의 텍스처 이름(확장자 제외). SpineAtlasAsset은 페이지를 Texture2D.name으로 찾는다(PC NoteSkinRules). */
export function atlasTextureName(atlasText: string, fallback: string): string {
    for (const raw of atlasText.split(/\r?\n/)) {
        const line = raw.replace(/^﻿/, "").trim();
        if (!line) continue;
        if (line.includes(":")) return fallback;
        const name = line.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
        return name || fallback;
    }
    return fallback;
}

/** 원본 에셋 이름 → 세트 이름. 0506_road_SkeletonData → 0506_road. 경로로 쓰이므로 이상한 이름은 null. */
export function baseNameFromAssetName(assetName: string | null): string | null {
    if (!assetName) return null;
    let name = assetName.trim();
    if (name.toLowerCase().endsWith(SKELETON_DATA_SUFFIX.toLowerCase())) name = name.substring(0, name.length - SKELETON_DATA_SUFFIX.length);
    if (!name || name === "." || name === ".." || /[\\/:*?"<>|\0]/.test(name)) return null;
    return name;
}

/** 세트 파일 미리 검사. 문제가 없으면 null, 있으면 이유. */
export function checkSetFiles(jsonText: string, atlasText: string): string | null {
    let json: any;
    try { json = JSON.parse(jsonText); } catch (e) { return `JSON 문법 오류(.skel 바이너리를 이름만 바꾼 파일?): ${`${e}`.substring(0, 80)}`; }
    const version = `${json?.skeleton?.spine ?? ""}`;
    if (!version.startsWith("3.8")) return `Spine 버전 ${version || "없음"} (게임은 3.8)`;
    if (!json.bones || !json.slots) return "bones/slots 없음";
    const firstLine = atlasText.split(/\r?\n/).map(l => l.replace(/^﻿/, "").trim()).find(l => l.length > 0) ?? "";
    if (!firstLine || firstLine.includes(":")) return "아틀라스 첫 줄이 페이지 이름이 아님";
    return null;
}

export function setStamp(dir: string, base: string): number {
    let stamp = 17;
    for (const ext of ["png", "atlas", "json"]) {
        const size = regularFileSize(`${dir}/${base}.${ext}`);
        if (size < 0) return 0;
        stamp = (stamp * 31 + size) % 2147483647;
    }
    return stamp === 0 ? 1 : stamp;
}

export function readTextFile(path: string): string {
    return File.readAllText(path).replace(/^﻿/, "");
}
