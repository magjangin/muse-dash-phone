// 멈춤 감시: 메인 스레드 프레임(UnityGameManager.LoopUpdate)이 오래 끊기면 모든 스레드의 위치를 mod.log에 남긴다.
// 2026-11-07~09 로딩 화면 멈춤(LoadFromName("collection_bundle")에서 돌아오지 않음)은 스레드 스택이 없어 원인을 확정하지 못했다.
// 다음에 멈추면 이 기록(watchdog-dump)으로 UnityMain이 어디서 무엇을 기다리는지 본다.
// 타이머는 스크립트 스레드에서 돈다 → 여기선 IL2CPP API를 부르지 않는다(perform "free"로 그 스레드는 IL2CPP에서 떨어져 있다).
// 앱이 백그라운드로 가도 프레임이 멈추므로 덤프가 찍힐 수 있다. 프레임이 다시 오면 watchdog-resume(gapMs)이 찍히니 그걸로 구분한다.
import { log } from "./log.js";
import { onFrame } from "./frame.js";

const STALL_MS = 10000;          // 프레임이 이만큼 끊기면 덤프
const FIRST_FRAME_MS = 60000;    // 설치 뒤 이만큼 첫 프레임이 없으면 덤프
const MAX_FRAMES = 14;

let lastBeat = 0;
let installedAt = 0;
let dumped = false;              // 한 번 끊긴 동안 한 번만
let dumps = 0;

function where(addr: NativePointer): string {
    const m = Process.findModuleByAddress(addr);
    return m ? `${m.name}+0x${addr.sub(m.base).toString(16)}` : addr.toString();
}

function wchan(tid: number): string | null {
    try {
        return File.readAllText(`/proc/self/task/${tid}/wchan`).trim();
    } catch (_) {
        return null;
    }
}

function dumpThreads(reason: string, gapMs: number): void {
    const threads: object[] = [];
    for (const t of Process.enumerateThreads()) {
        let bt: string[] = [];
        try {
            bt = Thread.backtrace(t.context, Backtracer.FUZZY).slice(0, MAX_FRAMES).map(where);
        } catch (_) {
            // 백트레이스 실패는 pc만 남긴다
        }
        threads.push({ id: t.id, name: t.name ?? null, state: t.state, wchan: wchan(t.id), pc: where(t.context.pc), bt });
    }
    // 한 줄이 너무 길어지지 않게 스레드마다 한 줄
    log({ t: "watchdog-dump", reason, gapMs, threads: threads.length });
    for (const th of threads) log({ t: "watchdog-thread", ...th });
}

export function installWatchdog(): void {
    installedAt = Date.now();
    onFrame("watchdog", () => {
        const now = Date.now();
        if (lastBeat === 0) log({ t: "frame-first", afterMs: now - installedAt });
        else if (dumped) log({ t: "watchdog-resume", gapMs: now - lastBeat });
        dumped = false;
        lastBeat = now;
    });
    setInterval(() => {
        if (dumped || dumps >= 3) return;
        const now = Date.now();
        const gap = lastBeat === 0 ? now - installedAt : now - lastBeat;
        const limit = lastBeat === 0 ? FIRST_FRAME_MS : STALL_MS;
        if (gap < limit) return;
        dumped = true;
        dumps++;
        try {
            dumpThreads(lastBeat === 0 ? "no-first-frame" : "frame-stall", gap);
        } catch (e) {
            log({ t: "watchdog-error", error: `${e}` });
        }
    }, 2000);
    log({ t: "watchdog-ready", stallMs: STALL_MS });
}
