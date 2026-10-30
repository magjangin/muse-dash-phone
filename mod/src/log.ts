// script 모드엔 호스트가 없고 console.log도 logcat에 안 나온다 → 앱 전용 폴더의 mod.log에 한 줄씩 쓴다.
export const MOD_DIR = "/storage/emulated/0/Android/data/com.prpr.musedash.mod/files";

const file = new File(`${MOD_DIR}/mod.log`, "a");

export function log(message: object): void {
    file.write(`${Date.now()} ${JSON.stringify(message)}\n`);
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
