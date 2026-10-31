// 보존 아카이브의 DLC 에셋 캐시 복원. 앨범·DLC 번들은 OBB가 아니라 게임 CDN에서 받은 files/UnityCache(약 2 GB)와
// files/com.unity.addressables(카탈로그)에 있다 → 아카이브는 둘을 tar로 묶어 patch.<versionCode>.<패키지>.obb로 싣고
// (XAPK 설치기도 obb 폴더엔 쓸 수 있다), Unity가 뜨기 전(스크립트 로드 = onCreate 안)에 여기서 files/ 아래로 푼다.
// 그러면 CDN이 닫혀도 DLC 곡이 열린다. 2026-10-31 실측: 풀어 둔 캐시만으로 비행기 모드에서 DJMAX 콜라보 곡 배틀 진입.
// tar는 JS로 직접 푼다: libc system()으로 toybox tar를 부르면 Frida가 붙은 프로세스의 fork 자식이 exec 전에 멈춘다(실측).
import Java from "frida-java-bridge";
import { MOD_DIR, PACKAGE, log } from "./log.js";
import { fileExists, listDir, makeDir } from "./native.js";

const VERSION_CODE = 632;
const PACK = `/storage/emulated/0/Android/obb/${PACKAGE}/patch.${VERSION_CODE}.${PACKAGE}.obb`;
const SHARED = `${MOD_DIR}/UnityCache/Shared`;
// 푼 뒤 번들 폴더 수를 적어 둔다. 그보다 적으면(게임의 다운로드 삭제 등) 다음 실행 때 다시 푼다.
const MARKER = `${MOD_DIR}/UnityCache/.hwa_restored`;
// Unity Cache.expirationDelay 최댓값(150일). 안 쓴 번들은 이만큼 지나면 Unity가 지운다.
// 루트 __info 첫 줄 = 만료 시각, 번들별 __info 둘째 줄 = 마지막 사용 시각 → 만료 60일 전부터 지금 시각으로 다시 쓴다.
const EXPIRATION_DELAY = 12960000;
const REFRESH_BEFORE = 60 * 24 * 3600;
const CHUNK = 4 * 1024 * 1024;

// 첫 실행엔 files 폴더가 아직 없다. libc mkdir이 막히면 앱 컨텍스트로 만든다(StorageManager가 만들어 줌).
function ensureFilesDir(): void {
    if (fileExists(MOD_DIR)) return;
    makeDir(MOD_DIR.replace(/\/files$/, ""));
    makeDir(MOD_DIR);
    let via = "mkdir";
    if (!fileExists(MOD_DIR) && Java.available) {
        via = "java";
        Java.performNow(() => {
            const app = Java.use("android.app.ActivityThread").currentApplication();
            if (app !== null) app.getExternalFilesDir(null);
        });
    }
    log({ t: "files-dir", via, ok: fileExists(MOD_DIR) });
}

function bundleCount(): number {
    return listDir(SHARED).filter(e => e.isDir).length;
}

function field(header: Uint8Array, offset: number, length: number): string {
    let text = "";
    for (let i = offset; i < offset + length && header[i] !== 0; i++) text += String.fromCharCode(header[i]);
    return text;
}

const made = new Set<string>();

function makeDirs(path: string): void {
    let current = "";
    for (const part of path.split("/").filter(p => p.length > 0)) {
        current += `/${part}`;
        if (made.has(current)) continue;
        makeDir(current);
        made.add(current);
    }
}

function fileSize(path: string): number {
    if (!fileExists(path)) return -1;
    try {
        const f = new File(path, "rb");
        try {
            f.seek(0, File.SEEK_END);
            return f.tell();
        } finally {
            f.close();
        }
    } catch (_) {
        return -1;
    }
}

// GNU/ustar tar(폴더 '5'와 일반 파일 '0'만 씀)를 dest 아래로 푼다.
// 같은 크기 파일이 이미 있으면 건너뛴다: 캐시가 있는 기기에 업데이트로 patch OBB가 처음 들어오면 표시(MARKER)가 없어
// 2 GB를 전부 다시 써서 첫 실행이 약 2분 검은 화면이었다(2026-11-01 실측 126초).
function extractTar(pack: string, dest: string): { files: number; bytes: number; kept: number } {
    const input = new File(pack, "rb");
    // Frida 17.24.3 File.seek(n, SEEK_CUR)는 readBytes 뒤에 stdio 버퍼 위치(4096) 기준으로 움직인다(실측) → tell()로 절대 위치를 준다.
    const skip = (n: number) => { if (n > 0) input.seek(input.tell() + n, File.SEEK_SET); };
    let files = 0;
    let bytes = 0;
    let kept = 0;
    try {
        for (;;) {
            const header = new Uint8Array(input.readBytes(512));
            if (header.length < 512 || header[0] === 0) break;
            const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
            const name = (prefix ? `${prefix}/` : "") + field(header, 0, 100);
            const size = parseInt(field(header, 124, 12).trim() || "0", 8);
            const type = header[156];
            if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`bad entry: ${name}`);
            const path = `${dest}/${name.replace(/\/+$/, "")}`;
            if (type === 0x35) {
                makeDirs(path);
            } else if ((type === 0x30 || type === 0) && fileSize(path) === size) {
                skip(size);
                kept++;
            } else if (type === 0x30 || type === 0) {
                makeDirs(path.substring(0, path.lastIndexOf("/")));
                const out = new File(path, "wb");
                let left = size;
                while (left > 0) {
                    const chunk = input.readBytes(Math.min(left, CHUNK));
                    if (chunk.byteLength === 0) throw new Error(`truncated: ${name}`);
                    out.write(chunk);
                    left -= chunk.byteLength;
                }
                out.close();
                files++;
                bytes += size;
            } else {
                skip(size);
            }
            skip((512 - (size % 512)) % 512);
        }
    } finally {
        input.close();
    }
    return { files, bytes, kept };
}

function restorePack(): void {
    if (!fileExists(PACK)) return;
    const expected = fileExists(MARKER) ? parseInt(File.readAllText(MARKER), 10) : NaN;
    const before = bundleCount();
    if (before >= expected) return;
    const started = Date.now();
    const result = extractTar(PACK, MOD_DIR);
    const after = bundleCount();
    if (after > 0) File.writeAllText(MARKER, `${after}`);
    log({ t: "cache-restore", before, after, ...result, ms: Date.now() - started });
}

function refreshExpiry(): void {
    const rootInfo = `${SHARED}/__info`;
    if (!fileExists(rootInfo)) return;
    const lines = File.readAllText(rootInfo).split("\n");
    const now = Math.floor(Date.now() / 1000);
    if (!/^\d+$/.test(lines[0]) || parseInt(lines[0], 10) - now > REFRESH_BEFORE) return;
    let entries = 0;
    for (const bundle of listDir(SHARED)) {
        if (!bundle.isDir) continue;
        for (const version of listDir(`${SHARED}/${bundle.name}`)) {
            const info = `${SHARED}/${bundle.name}/${version.name}/__info`;
            if (!version.isDir || !fileExists(info)) continue;
            const fields = File.readAllText(info).split("\n");
            if (fields.length < 2 || !/^\d+$/.test(fields[1])) continue;
            fields[1] = `${now}`;
            File.writeAllText(info, fields.join("\n"));
            entries++;
        }
    }
    lines[0] = `${now + EXPIRATION_DELAY}`;
    File.writeAllText(rootInfo, lines.join("\n"));
    log({ t: "cache-refresh", entries, expires: now + EXPIRATION_DELAY });
}

export function restoreCache(): void {
    ensureFilesDir();
    restorePack();
    refreshExpiry();
}
