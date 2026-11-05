// 게임의 난이도 값 두 가지 (PC 모드 CustomRecordStore.ResolveBattleDifficulty / ResolveSelectedDifficulty).
// 게임은 배틀 씬을 준비할 때(DBBattleStage.AwakeInit) BattleHelper.GetNoteJsonName(out m_MapDifficulty)로 값을 채운다.
// 그래서 m_MapDifficulty는 곡 선택 화면에서 탭을 바꿔도 다음 배틀 전까지 그대로다. 메뉴에서는 탭 칸을 직접 읽어야 한다.
const globalDataBase = () => Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.Database.GlobalDataBase");

/** 이번 배틀에서 실제로 불러온 난이도. 배틀 진입 후(채보 주입·보스·승리 기록)에 쓴다. 못 구하면 1. */
export function battleDifficulty(): number {
    const stage = globalDataBase().field<Il2Cpp.Object>("s_DbBattleStage").value;
    return stage && !stage.isNull() ? stage.method<number>("get_selectedDifficulty").invoke() : 1;
}

/** 곡 선택·준비 화면에서 지금 고른 난이도 탭. 메뉴의 기록 표시에 쓴다. 값이 없으면 battleDifficulty. */
export function selectedDifficulty(): number {
    const tag = globalDataBase().field<Il2Cpp.Object>("s_DbMusicTag").value;
    const selected = tag && !tag.isNull() ? tag.method<number>("get_selectedDiffTglIndex").invoke() : 0;
    return selected > 0 ? selected : battleDifficulty();
}
