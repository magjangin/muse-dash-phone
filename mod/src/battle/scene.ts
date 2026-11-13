// 씬: info.txt 씬 번호로 불러오기, 씬 전환은 배경만, 타이머 한도 늘리기 (battle.ts에서 분리, 2026-11-13).
import { log } from "../log.js";
import { pinnedString, readDecimal, readIl2CppString, writeDecimal } from "../native.js";
import { gameClass } from "../il2cpp.js";
import { battleDuration, battleSong, currentCustomSong } from "../customChart.js";

/** bool 반환 메서드를 조건이 참일 때만 true로 (원본은 안 부름). argTypes는 this·인자·MethodInfo* 순. */
function replaceBool(method: Il2Cpp.Method, argTypes: string[], when: () => boolean): void {
    const addr = method.virtualAddress;
    const original: any = new NativeFunction(addr, "bool", argTypes as any);
    const callback: any = (...args: any[]) => (when() ? 1 : (original(...args) ? 1 : 0));
    Interceptor.replace(addr, new NativeCallback(callback, "bool", argTypes as any));
}

export function installScene(): void {
    const GameMusicScene = gameClass("GameLogic.GameMusicScene");

    // 씬: info.txt 씬 번호로 (PC GameMusicScene_LoadScene_Patch)
    Interceptor.attach(GameMusicScene.method("LoadScene", 1).virtualAddress, {
        onEnter(args) {
            const song = currentCustomSong();
            const scene = song?.manifest.scene;
            if (!song || scene == null) return;
            const from = readIl2CppString(args[1]);
            const to = `scene_${String(scene).padStart(2, "0")}`;
            args[1] = pinnedString(to);
            log({ t: "scene-redirect", song: song.name, from, to });
        }
    });

    // 씬 전환은 배경만: 노트 정체(noteData/configData.note_uid)를 씬 기준으로 덮어쓰지 못하게 (PC SCENE_BACKGROUND_SWAP)
    replaceBool(gameClass("FormulaBase.StageBattleComponent").method("IsIgnoreCurrentNoteChecking", 1),
        ["pointer", "pointer", "pointer"], () => battleSong() !== null);
    replaceBool(GameMusicScene.method("IsIgnoreCurrentNoteChecking", 2),
        ["pointer", "int", "pointer", "pointer"], () => battleSong() !== null);

    // 씬 전환 노트가 노트 프리팹을 바꾸지 못하게 (PC SceneChangeController_ChangeNote_Patch)
    const changeNote = gameClass("SceneChangeController").method("ChangeNote", 1).virtualAddress;
    const changeNoteOriginal = new NativeFunction(changeNote, "void", ["pointer", "int", "pointer"]);
    Interceptor.replace(changeNote, new NativeCallback((self: NativePointer, sceneInfo: number, method: NativePointer) => {
        if (battleSong()) return;
        changeNoteOriginal(self, sceneInfo, method);
    }, "void", ["pointer", "int", "pointer"]));

    // 타이머: 숙주 곡보다 긴 커스텀 곡이 도중에 끝나지 않게 (PC GameMusicScene_InitTimer_Patch). Decimal 인자는 x1:x2.
    const scratch = Memory.alloc(16);
    Interceptor.attach(GameMusicScene.method("InitTimer", 1).virtualAddress, {
        onEnter(args) {
            if (!battleSong()) return;
            scratch.writePointer(args[1]);
            scratch.add(8).writePointer(args[2]);
            const current = readDecimal(scratch);
            const required = battleDuration() + 30;
            if (required > current) {
                writeDecimal(scratch, Math.ceil(required));
                args[1] = scratch.readPointer();
                args[2] = scratch.add(8).readPointer();
                log({ t: "timer-extend", from: current, to: Math.ceil(required) });
            }
        }
    });
}
