// 서버로 나가는 것 막기 + 세이브 오염 점검. 커스텀 곡 점수·가상 곡이 든 세이브가 서버에 올라가면 치트 판정을 받을 수 있어 올리지 않는다.
//  - StatisticsManager.UploadScore(SceneUploadResultData) 0x1ED32E8: OnBattleEnd → GameAccountSystem.UploadScore → musedash/v3/leaderboard/high-score
//  - GameAccountSystem.Synchronize() 0x22F5D78: 클라우드 세이브 올리기 → musedash/v2/save
// 둘 다 void이고 결과를 기다리는 화면이 없어 빈 함수로 바꾼다. (API 경로 문자열 → 참조 함수로 찾음)
import { log } from "./log.js";
import { VIRTUAL_PREFIX } from "./hwa/library.js";

const BLOCK: Record<string, number> = {
    "StatisticsManager::UploadScore(SceneUploadResultData)": 0x1ED32E8,
    "GameAccountSystem::Synchronize": 0x22F5D78
};

export function installSafety(): void {
    const base = Il2Cpp.module.base;
    for (const [name, rva] of Object.entries(BLOCK)) {
        let count = 0;
        Interceptor.replace(base.add(rva), new NativeCallback((self: NativePointer) => {
            if (count++ < 3) log({ t: "blocked", name, count });
        }, "void", ["pointer", "pointer", "pointer"]));
    }

    // 세이브에 가상 곡(1999-*) 기록이 어디로 들어가는지 확인용 1회 덤프 (읽기 전용). 정리 로직은 이 결과를 보고 만든다.
    const dataManager = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.PeroTools.Nice.Datas.DataManager");
    let dumped = false;
    let saveCalls = 0;
    // 다른 저장 경로(PeroTools2.Datas.DataManager.Save 0x21C25A0)도 불리는지 본다.
    Interceptor.attach(Il2Cpp.module.base.add(0x21C25A0), {
        onEnter() { log({ t: "save-call", which: "PeroTools2.Datas.DataManager" }); }
    });
    Interceptor.attach(dataManager.method("Save").virtualAddress, {
        onEnter(args) {
            if (saveCalls++ < 5) log({ t: "save-call", which: "Nice.Datas.DataManager", n: saveCalls });
            if (dumped) return;
            try {
                const dm = new Il2Cpp.Object(args[0]);
                const uids = dm.method<Il2Cpp.Object>("GetUids").invoke();
                const n = uids.method<number>("get_Count").invoke();
                const found: object[] = [];
                for (let i = 0; i < n; i++) {
                    const uid = uids.method<Il2Cpp.String>("get_Item").invoke(i).content ?? "";
                    const obj = dm.method<Il2Cpp.Object>("get_Item").invoke(Il2Cpp.string(uid));
                    if (!obj || obj.isNull()) continue;
                    const json = obj.method<Il2Cpp.String>("ToJson").invoke().content ?? "";
                    let at = json.indexOf(VIRTUAL_PREFIX);
                    const snippets: string[] = [];
                    while (at >= 0 && snippets.length < 4) {
                        snippets.push(json.substring(Math.max(0, at - 120), at + 80));
                        at = json.indexOf(VIRTUAL_PREFIX, at + 1);
                    }
                    if (snippets.length) found.push({ uid, length: json.length, snippets });
                }
                if (found.length) dumped = true;
                log({ t: "save-virtual-entries", objects: n, found });
            } catch (e) {
                dumped = true;
                log({ t: "save-dump-error", error: `${e}` });
            }
        }
    });
    log({ t: "safety-ready", blocked: Object.keys(BLOCK) });
}
