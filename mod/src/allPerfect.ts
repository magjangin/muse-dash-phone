// 올퍼펙트 배너 연출 및 판정 파라미터 조작 (PC APModPatch + ForcePerfectPatch 이식본).
// 1. GameTouchPlay.TouchResult (0x1D4D0D4)를 가로채 타격 판정을 Prefect(4)로 보정.
// 2. PnlVictory2dManager.ShowFullCombo (0x1C806E0) 훅으로 클리어 시 "ALL PERFECT !" 황금 배너 표시.
import { log } from "./log.js";
import { stopBga } from "./bga.js";

const RVA = {
    TouchResult: 0x1D4D0D4,         // GameTouchPlay.TouchResult(int idx, byte resultCode, uint actionType, TimeNodeOrder tno, bool isSkill, bool isElfinSkill)
    ShowFullCombo: 0x1C806E0,       // PnlVictory2dManager.ShowFullCombo()
    OnShowVictory: 0x1C808E0,       // PnlVictory2dManager.OnShowVictory(...)
    IsFullCombo: 0x205B6AC          // TaskStageTarget.IsFullCombo()
};

let forcePerfectEnabled = true;

export function setForcePerfect(enable: boolean): void {
    forcePerfectEnabled = enable;
    log({ t: "force-perfect-toggle", enable });
}

function isAllPerfect(): boolean {
    try {
        const TaskStageTarget = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("Assets.Scripts.GameCore.HostComponent.TaskStageTarget");
        const instance = TaskStageTarget.method<Il2Cpp.Object>("get_instance").invoke();
        if (!instance || instance.isNull()) return false;

        const isFc = instance.method<boolean>("IsFullCombo").invoke();
        const miss = instance.field<number>("m_MissResult").value;
        const great = instance.field<number>("m_GreatResult").value;

        return isFc && miss === 0 && great === 0;
    } catch (e) {
        log({ t: "ap-check-error", error: `${e}` });
        return false;
    }
}

export function installAllPerfect(): void {
    const base = Il2Cpp.module.base;

    // 1단계: 실시간 판정 강제 퍼펙트 보정 (GameTouchPlay.TouchResult)
    // TaskResult: Miss=1, Cool=2, Great=3, Prefect=4
    Interceptor.attach(base.add(RVA.TouchResult), {
        onEnter(args) {
            if (!forcePerfectEnabled) return;
            const res = args[2].toUInt32();
            if (res === 1 || res === 2 || res === 3) {
                args[2] = ptr(4); // Prefect (게임 원본 표기)
            }
        }
    });

    // 2단계: OnShowVictory 진입 시 BGA 정지
    Interceptor.attach(base.add(RVA.OnShowVictory), {
        onEnter() {
            stopBga();
        }
    });

    // 3단계: ShowFullCombo() 진입 시점에 AP 확인 및 배너 커스터마이징
    Interceptor.attach(base.add(RVA.ShowFullCombo), {
        onEnter(args) {
            try {
                if (!isAllPerfect()) return;

                const mgr = new Il2Cpp.Object(args[0]);
                const comp = mgr.field<Il2Cpp.Object>("m_CurVictoryComp").value;
                if (!comp || comp.isNull()) return;

                const fullComboGo = comp.field<Il2Cpp.Object>("fullCombo").value;
                if (!fullComboGo || fullComboGo.isNull()) return;

                const fcTf = fullComboGo.method<Il2Cpp.Object>("get_transform").invoke();
                if (!fcTf || fcTf.isNull()) return;

                const childCount = fcTf.method<number>("get_childCount").invoke();
                for (let i = 0; i < childCount; i++) {
                    const child = fcTf.method<Il2Cpp.Object>("GetChild").invoke(i);
                    if (!child || child.isNull()) continue;
                    const cgo = child.method<Il2Cpp.Object>("get_gameObject").invoke();
                    const name = cgo.method<Il2Cpp.String>("get_name").invoke().content;
                    if (name !== "CustomAPText") {
                        cgo.method("SetActive").invoke(false);
                    }
                }

                const existing = fcTf.method<Il2Cpp.Object>("Find").invoke(Il2Cpp.string("CustomAPText"));
                if (existing && !existing.isNull()) {
                    existing.method<Il2Cpp.Object>("get_gameObject").invoke().method("SetActive").invoke(true);
                    log({ t: "all-perfect-banner", status: "reused" });
                    return;
                }

                // CustomAPText 생성
                const GameObject = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.GameObject");
                const apGo = GameObject.new();
                apGo.method(".ctor", 1).invoke(Il2Cpp.string("CustomAPText"));

                const apTf = apGo.method<Il2Cpp.Object>("get_transform").invoke();
                apTf.method("SetParent", 2).invoke(fcTf, false);

                // Text 컴포넌트 추가
                const UI = Il2Cpp.domain.assembly("UnityEngine.UI").image;
                const TextClass = UI.class("UnityEngine.UI.Text");
                const textComp = apGo.method<Il2Cpp.Object>("AddComponent", 1).invoke(TextClass.type.object);

                if (textComp && !textComp.isNull()) {
                    textComp.method("set_text").invoke(Il2Cpp.string("ALL PERFECT !"));
                    textComp.method("set_fontSize").invoke(110);
                    textComp.method("set_alignment").invoke(4); // TextAnchor.MiddleCenter = 4

                    // Color(1, 0.85, 0, 1) - 골드
                    const ColorClass = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Color");
                    const color = ColorClass.new();
                    color.field("r").value = 1.0;
                    color.field("g").value = 0.85;
                    color.field("b").value = 0.0;
                    color.field("a").value = 1.0;
                    textComp.method("set_color").invoke(color);

                    // RectTransform
                    const rect = apGo.method<Il2Cpp.Object>("GetComponent", 1).invoke(
                        Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.RectTransform").type.object
                    );
                    if (rect && !rect.isNull()) {
                        const Vector2Class = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Vector2");
                        const size = Vector2Class.new();
                        size.field("x").value = 1000.0;
                        size.field("y").value = 200.0;
                        rect.method("set_sizeDelta").invoke(size);
                    }
                }

                log({ t: "all-perfect-banner", status: "created" });
            } catch (e) {
                log({ t: "all-perfect-error", error: `${e}` });
            }
        }
    });

    log({ t: "all-perfect-ready" });
}
