// 메모리·파일 저수준 헬퍼: System.Decimal 읽기/쓰기, 디렉터리 나열(libc), Il2Cpp 문자열 고정.

// System.Decimal (dump.cs): flags @0 (scale = bits 16~23, 부호 = bit 31), hi @4, lo @8, mid @0xC. 값 = (hi:mid:lo) / 10^scale.
const DECIMAL_SCALE = 6;

export function readDecimal(p: NativePointer): number {
    const flags = p.readU32();
    const hi = p.add(4).readU32();
    const lo = p.add(8).readU32();
    const mid = p.add(12).readU32();
    const scale = (flags >>> 16) & 0xFF;
    const mantissa = lo + mid * 4294967296 + hi * 18446744073709551616;
    const value = mantissa / Math.pow(10, scale);
    return (flags & 0x80000000) !== 0 ? -value : value;
}

export function writeDecimal(p: NativePointer, value: number): void {
    const negative = value < 0;
    let mantissa = Math.round(Math.abs(value) * Math.pow(10, DECIMAL_SCALE));
    let scale = DECIMAL_SCALE;
    // 끝의 0을 덜어 게임이 만든 값(예: 1.48 = 148 / 10^2)과 같은 모양으로 맞춘다.
    while (scale > 0 && mantissa % 10 === 0 && mantissa !== 0) {
        mantissa /= 10;
        scale--;
    }
    if (mantissa === 0) scale = 0;
    const lo = mantissa % 4294967296;
    const mid = Math.floor(mantissa / 4294967296);
    // `>>> 0`: 부호 비트를 켜면 JS 비트 연산 결과가 음수가 되어 writeU32가 예외를 던진다(음수 delay가 안 먹던 원인).
    p.writeU32((((scale & 0xFF) << 16) | (negative && mantissa !== 0 ? 0x80000000 : 0)) >>> 0);
    p.add(4).writeU32(0);
    p.add(8).writeU32(lo >>> 0);
    p.add(12).writeU32(mid >>> 0);
}

export function readIl2CppString(p: NativePointer): string | null {
    if (p.isNull()) return null;
    return p.add(0x14).readUtf16String(p.add(0x10).readS32());
}

// 우리가 만든 문자열은 모드가 쓴 구조체(노트 배열) 안에서만 참조된다. 쓰기 장벽 없이 넣으므로 GC가 놓치지 않게 고정해 둔다.
const pinned = new Map<string, NativePointer>();

export function pinnedString(text: string): NativePointer {
    let p = pinned.get(text);
    if (p === undefined) {
        const s = Il2Cpp.string(text);
        s.object.ref(true);
        p = s.handle;
        pinned.set(text, p);
    }
    return p;
}

// ---- 파일 시스템 (Gum엔 디렉터리 나열이 없어 libc를 직접 부른다) ----
const libc = Process.getModuleByName("libc.so");
const opendir = new NativeFunction(libc.getExportByName("opendir"), "pointer", ["pointer"]);
const readdir = new NativeFunction(libc.getExportByName("readdir"), "pointer", ["pointer"]);
const closedir = new NativeFunction(libc.getExportByName("closedir"), "int", ["pointer"]);
const access = new NativeFunction(libc.getExportByName("access"), "int", ["pointer", "int"]);
const mkdirNative = new NativeFunction(libc.getExportByName("mkdir"), "int", ["pointer", "int"]);

export function makeDir(path: string): number {
    return mkdirNative(Memory.allocUtf8String(path), 0o777) as number;
}

const DT_DIR = 4;

export interface DirEntry { name: string; isDir: boolean; }

/** bionic arm64 struct dirent: d_ino(8) d_off(8) d_reclen(2) d_type(1) d_name[256] @19 */
export function listDir(path: string): DirEntry[] {
    const dir = opendir(Memory.allocUtf8String(path)) as NativePointer;
    if (dir.isNull()) return [];
    const out: DirEntry[] = [];
    try {
        for (;;) {
            const ent = readdir(dir) as NativePointer;
            if (ent.isNull()) break;
            const name = ent.add(19).readUtf8String();
            if (!name || name === "." || name === "..") continue;
            out.push({ name, isDir: ent.add(18).readU8() === DT_DIR });
        }
    } finally {
        closedir(dir);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function fileExists(path: string): boolean {
    return (access(Memory.allocUtf8String(path), 0) as number) === 0;
}

/** 있는지가 아니라 이 앱이 실제로 읽을 수 있는지. 공용 저장소의 남이 만든 이미지는 보이기만 하고 열면 실패한다. */
export function fileReadable(path: string): boolean {
    try {
        const f = new File(path, "rb");
        try {
            return f.readBytes(8).byteLength > 0;
        } finally {
            f.close();
        }
    } catch (_) {
        return false;
    }
}

export function readText(path: string): string {
    return File.readAllText(path);
}
