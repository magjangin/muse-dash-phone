// 올퍼펙트 배너 연출 및 판정 파라미터 조작 (PC APModPatch + ForcePerfectPatch 이식본).
// 1. GameTouchPlay.TouchResult (0x1D4D0D4)를 가로채 타격 판정을 Prefect(4)로 보정.
// 2. PnlVictory2dManager.ShowFullCombo (0x1C806E0) & OnShowVictory (0x1C808E0) 훅으로 클리어 시 "ALL PERFECT !" 황금 배너 표시.
import { log } from "./log.js";
import { stopBga } from "./bga.js";

const RVA = {
    TouchResult: 0x1D4D0D4,         // GameTouchPlay.TouchResult(int idx, byte resultCode, uint actionType, TimeNodeOrder tno, bool isSkill, bool isElfinSkill)
    ShowFullCombo: 0x1C806E0,       // PnlVictory2dManager.ShowFullCombo()
    OnShowVictory: 0x1C808E0        // PnlVictory2dManager.OnShowVictory(...)
};

let forcePerfectEnabled = true;

export function setForcePerfect(enable: boolean): void {
    forcePerfectEnabled = enable;
    log({ t: "force-perfect-toggle", enable });
}

function makeColor(r: number, g: number, b: number, a: number): Il2Cpp.ValueType {
    const ColorClass = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Color");
    const color = ColorClass.alloc().unbox();
    color.field<number>("r").value = r;
    color.field<number>("g").value = g;
    color.field<number>("b").value = b;
    color.field<number>("a").value = a;
    return color;
}

function makeVector2(x: number, y: number): Il2Cpp.ValueType {
    const Vector2Class = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Vector2");
    const v = Vector2Class.alloc().unbox();
    v.field<number>("x").value = x;
    v.field<number>("y").value = y;
    return v;
}

function resolveFont(): Il2Cpp.Object | null {
    try {
        const UI = Il2Cpp.domain.assembly("UnityEngine.UI").image;
        const TextClass = UI.class("UnityEngine.UI.Text");
        const ObjectClass = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Object");
        const texts = ObjectClass.method<Il2Cpp.Array<Il2Cpp.Object>>("FindObjectsOfType", 1).invoke(TextClass.type.object);
        if (texts && texts.length > 0) {
            for (let i = 0; i < texts.length; i++) {
                const t = texts.get(i);
                if (!t || t.isNull()) continue;
                const font = t.method<Il2Cpp.Object>("get_font").invoke();
                if (font && !font.isNull()) {
                    return font;
                }
            }
        }
    } catch (e) {
        log({ t: "resolve-font-texts-error", error: `${e}` });
    }

    try {
        const Resources = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Resources");
        const FontClass = Il2Cpp.domain.assembly("UnityEngine.TextRenderingModule").image.class("UnityEngine.Font");
        const fonts = Resources.method<Il2Cpp.Array<Il2Cpp.Object>>("FindObjectsOfTypeAll", 1).invoke(FontClass.type.object);
        if (fonts && fonts.length > 0) {
            for (let i = 0; i < fonts.length; i++) {
                const f = fonts.get(i);
                if (f && !f.isNull()) return f;
            }
        }
    } catch (e) {
        log({ t: "resolve-font-resources-error", error: `${e}` });
    }

    return null;
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

function showAllPerfectBannerOnComp(comp: Il2Cpp.Object): void {
    if (!comp || comp.isNull()) return;

    const fullComboGo = comp.field<Il2Cpp.Object>("fullCombo").value;
    if (!fullComboGo || fullComboGo.isNull()) return;

    const fcTf = fullComboGo.method<Il2Cpp.Object>("get_transform").invoke();
    if (!fcTf || fcTf.isNull()) return;

    // 풀콤보 오브젝트 활성화 보장
    fullComboGo.method("SetActive").invoke(true);

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

    // CustomAPText GameObject 신규 생성
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
        const font = resolveFont();
        if (font && !font.isNull()) {
            textComp.method("set_font").invoke(font);
        }
        textComp.method("set_text").invoke(Il2Cpp.string("ALL PERFECT !"));
        textComp.method("set_fontSize").invoke(110);
        textComp.method("set_alignment").invoke(4); // TextAnchor.MiddleCenter = 4
        textComp.method("set_color").invoke(makeColor(1.0, 0.85, 0.0, 1.0)); // 황금색

        // Shadow 컴포넌트
        try {
            const ShadowClass = UI.class("UnityEngine.UI.Shadow");
            const shadow = apGo.method<Il2Cpp.Object>("AddComponent", 1).invoke(ShadowClass.type.object);
            if (shadow && !shadow.isNull()) {
                shadow.method("set_effectColor").invoke(makeColor(0.0, 0.0, 0.0, 0.8));
                shadow.method("set_effectDistance").invoke(makeVector2(6.0, -6.0));
            }
        } catch (se) {
            log({ t: "ap-shadow-warning", error: `${se}` });
        }

        // Outline 컴포넌트
        try {
            const OutlineClass = UI.class("UnityEngine.UI.Outline");
            const outline = apGo.method<Il2Cpp.Object>("AddComponent", 1).invoke(OutlineClass.type.object);
            if (outline && !outline.isNull()) {
                outline.method("set_effectColor").invoke(makeColor(0.0, 0.0, 0.0, 1.0));
                outline.method("set_effectDistance").invoke(makeVector2(4.0, -4.0));
            }
        } catch (oe) {
            log({ t: "ap-outline-warning", error: `${oe}` });
        }

        // RectTransform 위치 및 크기
        const rect = apGo.method<Il2Cpp.Object>("GetComponent", 1).invoke(
            Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.RectTransform").type.object
        );
        if (rect && !rect.isNull()) {
            rect.method("set_sizeDelta").invoke(makeVector2(1000.0, 200.0));
            rect.method("set_anchoredPosition").invoke(makeVector2(0.0, 0.0));
        }
    }

    log({ t: "all-perfect-banner", status: "created" });
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

    // 2단계: OnShowVictory 진입 시 BGA 정지 및 AP 배너 검사
    Interceptor.attach(base.add(RVA.OnShowVictory), {
        onEnter(args) {
            stopBga();
            try {
                if (!isAllPerfect()) return;
                const mgr = new Il2Cpp.Object(args[0]);
                const comp = mgr.field<Il2Cpp.Object>("m_CurVictoryComp").value;
                showAllPerfectBannerOnComp(comp);
            } catch (e) {
                log({ t: "on-show-victory-ap-error", error: `${e}` });
            }
        }
    });

    // 3단계: ShowFullCombo() 진입 시점에 AP 배너 커스터마이징
    Interceptor.attach(base.add(RVA.ShowFullCombo), {
        onEnter(args) {
            try {
                if (!isAllPerfect()) return;
                const mgr = new Il2Cpp.Object(args[0]);
                const comp = mgr.field<Il2Cpp.Object>("m_CurVictoryComp").value;
                showAllPerfectBannerOnComp(comp);
            } catch (e) {
                log({ t: "show-full-combo-ap-error", error: `${e}` });
            }
        }
    });

    log({ t: "all-perfect-ready" });
}
