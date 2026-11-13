// 커스텀 곡 배틀 핵심 파이프라인 (PC 모드 Patches/Battle/Mechanics/BossPatch.cs, Patches/Scene/GameMusicScene*Patch.cs,
// SceneFlowPatch.cs, NoteAnimationSyncPatch.cs 이식). 전부 커스텀 곡일 때만 동작하고 순정 곡은 원본 그대로.
//  - 보스: Boss.Play("swap:<보스>:<씬>")를 InitBossObject + Play("in")으로 실행, 시작 보스를 BMS 첫 in 보스로, 교체 보스 미리 생성
//  - 씬: GameMusicScene.LoadScene을 info.txt 씬 번호로, 씬 전환은 배경만(IsIgnoreCurrentNoteChecking=true, ChangeNote 차단)
//  - 타이머: GameMusicScene.InitTimer 한도를 곡 길이+30초로
//  - 노트 애니메이션: 늦게 스폰된 노트의 Spine 시간을 즉시 보정
// 파일 나눔(2026-11-13): boss.ts, scene.ts(씬·타이머), sync.ts(offset·노트 애니메이션), accuracy.ts(정확도).
import { guard, log } from "../log.js";
import { installAccuracy } from "./accuracy.js";
import { installBoss } from "./boss.js";
import { installScene } from "./scene.js";
import { installNoteSync, installOffset } from "./sync.js";

export function installBattle(): void {
    guard("battle-accuracy", installAccuracy);
    guard("battle-boss", installBoss);
    guard("battle-scene", installScene);
    guard("battle-offset", installOffset);
    guard("battle-note-sync", installNoteSync);
    log({ t: "battle-ready" });
}
