// 서버로 나가는 것 막기 + 세이브 오염 방지 정밀 청소 (PC SaveDataManagerPatch 이식).
//  - StatisticsManager.UploadScore(SceneUploadResultData) 0x1ED32E8: 점수 업로드 차단
//  - GameAccountSystem.Synchronize() 0x22F5D78: 클라우드 세이브 업로드 차단
//  - DataManager.Save() 0x1E7D164: 저장 직전 인메모리 DB에서 모든 가상 데이터(1999-*, 1998-*) 정밀 제거(클렌징)
import { log } from "./log.js";
import { VIRTUAL_PREFIX } from "./hwa/library.js";

const BLOCK: Record<string, number> = {
    "StatisticsManager::UploadScore(SceneUploadResultData)": 0x1ED32E8,
    "GameAccountSystem::Synchronize": 0x22F5D78
};

function isVirtualKey(key: string): boolean {
    return key.startsWith(VIRTUAL_PREFIX) || key.startsWith("1998-") || key.includes("1999-");
}

function cleanSaveData(dm: Il2Cpp.Object): void {
    try {
        const datasDict = dm.method<Il2Cpp.Object>("get_datas").invoke();
        if (!datasDict || datasDict.isNull()) return;

        let totalRemovedFields = 0;

        // 1. 모든 컬렉션(Account, Task, IAP, StageAchievement 등) 필드 정밀 클렌징
        const keysObj = datasDict.method<Il2Cpp.Object>("get_Keys").invoke();
        const keysCount = keysObj.method<number>("get_Count").invoke();
        
        // C# IEnumerable / ICollection 순회를 위해 리스트 복사나 인덱스 접근
        const uids = dm.method<Il2Cpp.Object>("GetUids").invoke();
        const n = uids.method<number>("get_Count").invoke();

        for (let i = 0; i < n; i++) {
            const collectionName = uids.method<Il2Cpp.String>("get_Item").invoke(i).content ?? "";
            const subData = dm.method<Il2Cpp.Object>("get_Item").invoke(Il2Cpp.string(collectionName));
            if (!subData || subData.isNull()) continue;

            try {
                const getFields = subData.class.method<Il2Cpp.Object>("get_fields");
                const fields = getFields ? getFields.invoke() : null;
                if (!fields || fields.isNull()) continue;

                const fieldKeys = fields.method<Il2Cpp.Object>("get_Keys").invoke();
                const count = fieldKeys.method<number>("get_Count").invoke();
                if (count <= 0) continue;

                // Dictionary.Keys는 순회 중 Remove하면 InvalidOperationException 발생하므로 배열로 추출
                const toRemove: string[] = [];
                const toArrayMethod = fieldKeys.class.method<Il2Cpp.Array<Il2Cpp.String>>("ToArray");
                if (toArrayMethod) {
                    const arr = toArrayMethod.invoke();
                    for (let j = 0; j < arr.length; j++) {
                        const k = arr.get(j).content ?? "";
                        if (isVirtualKey(k)) toRemove.push(k);
                    }
                }

                for (const k of toRemove) {
                    fields.method("Remove").invoke(Il2Cpp.string(k));
                    totalRemovedFields++;
                }
            } catch (fe) {
                // 특정 서브데이터에 fields 프로퍼티가 없으면 무시
            }
        }

        // 2. Achievement 컬렉션 내부 리스트 클렌징 (highest, recentPassLevelData, easy/hard/master_pass)
        let highestRemoved = 0;
        let recentRemoved = 0;
        let passRemoved = 0;

        const achievement = dm.method<Il2Cpp.Object>("get_Item").invoke(Il2Cpp.string("Achievement"));
        if (achievement && !achievement.isNull()) {
            try {
                // highest 리스트
                const highestVar = achievement.method<Il2Cpp.Object>("GetVariable", 1).invoke(Il2Cpp.string("highest"));
                if (highestVar && !highestVar.isNull()) {
                    const highestList = highestVar.method<Il2Cpp.Object>("GetResult").invoke();
                    if (highestList && !highestList.isNull()) {
                        const hCount = highestList.method<number>("get_Count").invoke();
                        for (let j = hCount - 1; j >= 0; j--) {
                            const item = highestList.method<Il2Cpp.Object>("get_Item").invoke(j);
                            if (!item || item.isNull()) continue;
                            const uidVar = item.method<Il2Cpp.Object>("GetVariable", 1).invoke(Il2Cpp.string("uid"));
                            if (uidVar && !uidVar.isNull()) {
                                const uidObj = uidVar.method<Il2Cpp.Object>("GetResult").invoke();
                                const uid = uidObj ? uidObj.toString() : "";
                                if (isVirtualKey(uid)) {
                                    highestList.method("RemoveAt", 1).invoke(j);
                                    highestRemoved++;
                                }
                            }
                        }
                    }
                }

                // recentPassLevelData 리스트
                const recentVar = achievement.method<Il2Cpp.Object>("GetVariable", 1).invoke(Il2Cpp.string("recentPassLevelData"));
                if (recentVar && !recentVar.isNull()) {
                    const recentList = recentVar.method<Il2Cpp.Object>("GetResult").invoke();
                    if (recentList && !recentList.isNull()) {
                        const rCount = recentList.method<number>("get_Count").invoke();
                        for (let j = rCount - 1; j >= 0; j--) {
                            const item = recentList.method<Il2Cpp.Object>("get_Item").invoke(j);
                            if (!item || item.isNull()) continue;
                            const uidVar = item.method<Il2Cpp.Object>("GetVariable", 1).invoke(Il2Cpp.string("uid"));
                            if (uidVar && !uidVar.isNull()) {
                                const uidObj = uidVar.method<Il2Cpp.Object>("GetResult").invoke();
                                const uid = uidObj ? uidObj.toString() : "";
                                if (isVirtualKey(uid)) {
                                    recentList.method("RemoveAt", 1).invoke(j);
                                    recentRemoved++;
                                }
                            }
                        }
                    }
                }

                // 난이도별 패스 리스트 (easy_pass, hard_pass, master_pass)
                for (const pk of ["easy_pass", "hard_pass", "master_pass"]) {
                    const passVar = achievement.method<Il2Cpp.Object>("GetVariable", 1).invoke(Il2Cpp.string(pk));
                    if (passVar && !passVar.isNull()) {
                        const passList = passVar.method<Il2Cpp.Object>("GetResult").invoke();
                        if (passList && !passList.isNull()) {
                            const pCount = passList.method<number>("get_Count").invoke();
                            for (let j = pCount - 1; j >= 0; j--) {
                                const valStr = passList.method<Il2Cpp.String>("get_Item").invoke(j).content ?? "";
                                if (isVirtualKey(valStr)) {
                                    passList.method("RemoveAt", 1).invoke(j);
                                    passRemoved++;
                                }
                            }
                        }
                    }
                }
            } catch (ae) {
                // Achievement 내부 구조 차이 예외 보호
            }
        }

        if (totalRemovedFields > 0 || highestRemoved > 0 || recentRemoved > 0 || passRemoved > 0) {
            log({
                t: "save-cleaned",
                removedFields: totalRemovedFields,
                highestRemoved,
                recentRemoved,
                passRemoved
            });
        }
    } catch (e) {
        log({ t: "save-clean-error", error: `${e}` });
    }
}

export function installSafety(): void {
    const base = Il2Cpp.module.base;
    for (const [name, rva] of Object.entries(BLOCK)) {
        let count = 0;
        Interceptor.replace(base.add(rva), new NativeCallback((self: NativePointer) => {
            if (count++ < 3) log({ t: "blocked", name, count });
        }, "void", ["pointer", "pointer", "pointer"]));
    }

    // DataManager.Save() 직전에 가상 곡 세이브 오염 정밀 청소 실행
    const dataManager = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.PeroTools.Nice.Datas.DataManager");
    let saveCalls = 0;

    Interceptor.attach(dataManager.method("Save").virtualAddress, {
        onEnter(args) {
            if (saveCalls++ < 10) log({ t: "save-call", which: "Nice.Datas.DataManager", n: saveCalls });
            try {
                const dm = new Il2Cpp.Object(args[0]);
                cleanSaveData(dm);
            } catch (e) {
                log({ t: "save-clean-dispatch-error", error: `${e}` });
            }
        }
    });

    log({ t: "safety-ready", blocked: Object.keys(BLOCK) });
}
