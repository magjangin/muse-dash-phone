// 커버 그림 파일 → Sprite (customTag.ts에서 분리, 2026-11-13).
import { byteArrayFromFile, unityClass } from "../il2cpp.js";

/** PNG/JPG 파일 → Sprite (Texture2D + ImageConversion.LoadImage + Sprite.Create). 실패하면 null. */
export function spriteFromFile(path: string): Il2Cpp.Object | null {
    const array = byteArrayFromFile(path);
    const tex = unityClass("UnityEngine.CoreModule", "UnityEngine.Texture2D").alloc();
    tex.method(".ctor").overload("System.Int32", "System.Int32").invoke(2, 2);
    const ok = unityClass("UnityEngine.ImageConversionModule", "UnityEngine.ImageConversion")
        .method<boolean>("LoadImage", 3).invoke(tex, array, false);
    if (!ok) return null;
    const w = tex.method<number>("get_width").invoke();
    const h = tex.method<number>("get_height").invoke();
    const rect = unityClass("UnityEngine.CoreModule", "UnityEngine.Rect").alloc().unbox();
    rect.field<number>("m_XMin").value = 0;
    rect.field<number>("m_YMin").value = 0;
    rect.field<number>("m_Width").value = w;
    rect.field<number>("m_Height").value = h;
    const pivot = unityClass("UnityEngine.CoreModule", "UnityEngine.Vector2").alloc().unbox();
    pivot.field<number>("x").value = 0.5;
    pivot.field<number>("y").value = 0.5;
    // meshType FullRect: 기본(Tight)은 알파 외곽선으로 메시를 만들어 720px 커버 1장에 21~52 ms가 걸렸다(2026-11-13 실측,
    // 태그 진입 때 5장이 한 프레임에 몰려 641 ms 멈춤). 커버는 네모 그림이라 FullRect로 충분하다.
    const meshTypes = unityClass("UnityEngine.CoreModule", "UnityEngine.SpriteMeshType");
    const sprite = unityClass("UnityEngine.CoreModule", "UnityEngine.Sprite").method<Il2Cpp.Object>("Create")
        .overload("UnityEngine.Texture2D", "UnityEngine.Rect", "UnityEngine.Vector2", "System.Single", "System.UInt32", "UnityEngine.SpriteMeshType")
        .invoke(tex, rect, pivot, 100, 0, meshTypes.field<Il2Cpp.ValueType>("FullRect").value);
    if (!sprite || sprite.isNull()) return null;
    tex.ref(true);
    sprite.ref(true);
    // 씬 전환 때 Resources.UnloadUnusedAssets에 지워지지 않게 한다.
    sprite.method("set_hideFlags").invoke(32);   // HideFlags.DontUnloadUnusedAsset
    tex.method("set_hideFlags").invoke(32);
    return sprite;
}
