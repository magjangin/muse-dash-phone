// il2cpp-bridge가 이 빌드에서 이름으로 제대로 찾는지 확인: 클래스·메서드를 이름으로 찾아 dump.cs RVA와 비교한다.
import { log } from "./log.js";

const EXPECT: [string, string, number][] = [
    ["MusicTagManager", "InitAlbumTagInfo", 0x1DE4E34],
    ["Assets.Scripts.Database.DBStageInfo", "SetRuntimeMusicData", 0x20D29D4],
    ["Assets.Scripts.Database.MusicInfo", "GetLocal", 0x1CAC538],
    ["FormulaBase.StageBattleComponent", "GetMusicDataFromStageInfo", 0x1D64890]
];

export function probe(): void {
    const image = Il2Cpp.domain.assembly("Assembly-CSharp").image;
    const results = EXPECT.map(([cls, method, rva]) => {
        const k = image.tryClass(cls);
        const m = k?.tryMethod(method);
        const got = m ? m.relativeVirtualAddress.toInt32() : null;
        return { cls, method, expect: `0x${rva.toString(16)}`, got: got === null ? null : `0x${got.toString(16)}`, ok: got === rva };
    });
    log({ t: "probe", unity: Il2Cpp.unityVersion, results });
}
