// 곡 폴더에서 채보 파일을 고르는 순수 규칙. 게임·Frida에 의존하지 않아 node로 바로 검사할 수 있다.
// PC 모드 Bms/BmsFileNames.cs + HwaResourceManager.Bms.cs(FindPreferredBmsFile) 이식본.

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

/** 게임의 난이도 문자열로 그 난이도 에셋이 있는지 본다. 없는 난이도는 "0"이나 빈 값이고, "?" 같은 표기는 있는 것이다. */
export function hasMapForLevel(level: string | null | undefined): boolean {
    const text = (level ?? "").trim();
    return text !== "" && text !== "0";
}

/**
 * 숙주 곡에서 불러올 차트 에셋의 난이도 번호. 숙주 차트는 노트를 복제할 틀로만 쓰이므로 어느 난이도여도 된다.
 * 고른 난이도가 있으면 그대로, 없으면 그보다 낮은 것 중 가장 높은 것, 그것도 없으면 가장 낮은 것.
 */
export function pickHostMap(available: number[], difficulty: number): number {
    if (available.length === 0 || available.includes(difficulty)) return difficulty;
    const lower = available.filter(d => d < difficulty);
    return lower.length > 0 ? Math.max(...lower) : Math.min(...available);
}

function sameName(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

/**
 * 기본 채보(난이도별 지정이 없는 난이도가 쓰는 채보)를 고른다.
 * 난이도에 지정된 파일은 먼저 빼고 고른다. easy.bms를 난이도1에 지정하고 hwa2.bms를 기본으로 둔 폴더에서,
 * 이름순으로 앞선다고 easy.bms가 다른 난이도의 기본 채보까지 되면 안 된다. 전부 지정됐으면 그중에서 고른다.
 */
export function pickDefaultBms(names: string[], claimedNames: string[] = []): string | null {
    const bms = names.filter(n => /\.bms$/i.test(n) && !isTempFile(n)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const pick = (list: string[]) => list.find(n => /^(chart|main|test)\.bms$/i.test(n)) ?? list[0] ?? null;
    return pick(bms.filter(n => !claimedNames.some(c => sameName(c, n)))) ?? pick(bms);
}

/**
 * info.txt의 '난이도N bms' 값을 곡 폴더 기준 상대 경로로 바꾼다. 쓸 수 없는 값이면 null.
 * 곡 폴더 안의 .bms만 받는다. 곡은 남이 만든 폴더째로 받기도 하므로 info.txt 한 줄이 폴더 밖 파일을 읽게 하지 않는다.
 * 기기 파일시스템은 대소문자를 가리지만 PC에서 만든 곡도 그대로 돌아야 하므로, 폴더 바로 아래 파일은 대소문자 없이 찾는다.
 */
export function resolveChartName(configured: string | null | undefined, names: string[]): string | null {
    if (!configured || !configured.trim()) return null;
    const name = configured.trim().replace(/\\/g, "/");
    if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
    if (!/\.bms$/i.test(name)) return null;
    const segments = name.split("/");
    if (segments.some(s => s === "" || s === "." || s === "..")) return null;
    if (segments.length > 1) return name;
    return names.find(n => sameName(n, name)) ?? null;
}
