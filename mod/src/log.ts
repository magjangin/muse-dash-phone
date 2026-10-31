// script 모드엔 호스트가 없고 console.log도 logcat에 안 나온다 → 앱 전용 폴더의 mod.log에 한 줄씩 쓴다.
// 패키지명은 프로세스 이름에서 읽는다 → 설치 스크립트로 다른 패키지명(-Package)을 줘도 같은 mod.js가 그 앱 폴더를 쓴다.
function packageName(): string {
    try {
        // cmdline은 NUL로 끝나 readAllText(UTF-8 디코드)가 예외를 낸다 → 바이트로 읽어 NUL·':'(서브 프로세스) 앞까지.
        let name = "";
        for (const b of new Uint8Array(File.readAllBytes("/proc/self/cmdline"))) {
            if (b === 0 || b === 0x3a) break;
            name += String.fromCharCode(b);
        }
        if (name.length > 0) return name;
    } catch (e) {
        // 못 읽으면 기본 복제본 이름
    }
    return "com.prpr.musedash.mod";
}

export const PACKAGE = packageName();
export const MOD_DIR = `/storage/emulated/0/Android/data/${PACKAGE}/files`;

// XAPK로 갓 깐 첫 실행엔 앱이 getExternalFilesDir를 부르기 전이라 files 폴더가 없어 로그를 못 연다.
// 그때 예외로 스크립트(해금 훅)가 죽지 않게, 열릴 때까지 줄을 모아 뒀다가 연 뒤에 한꺼번에 쓴다.
let file: File | null = null;
const pending: string[] = [];

export function log(message: object): void {
    const line = `${Date.now()} ${JSON.stringify(message)}\n`;
    if (file === null) {
        try {
            file = new File(`${MOD_DIR}/mod.log`, "a");
        } catch (e) {
            if (pending.length < 500) pending.push(line);
            return;
        }
        for (const old of pending.splice(0)) file.write(old);
    }
    file.write(line);
    file.flush();
}

// 한 기능의 예외가 나머지 기능을 막지 않게 감싼다 (PC 모드 FeatureGuard와 같은 역할).
export function guard(name: string, block: () => void): void {
    try {
        block();
    } catch (e) {
        log({ t: "error", feature: name, error: `${e}`, stack: (e as Error).stack });
    }
}
