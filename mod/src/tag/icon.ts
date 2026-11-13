// '실험 모드' 태그 아이콘 경로 고르기 (customTag.ts에서 분리, 2026-11-13).
import { MOD_DIR } from "../log.js";
import { fileReadable } from "../native.js";

const PUBLIC_TAG_ICON_PATH = "/storage/emulated/0/MuseDash/hwa_tag_icon.png";
const TAG_ICON_PATH = `${MOD_DIR}/hwa_tag_icon.png`;
// XAPK용 APK는 같은 아이콘을 lib/arm64-v8a/libhwa_tag_icon.so로 싣는다(embed_script_apk.py) → 게임 .so들과 같은 폴더에 풀린다.
// 폴더는 libil2cpp.so로 찾는다. Gadget은 자기 모듈을 목록에서 숨겨서 findModuleByName("libfrida-gadget.so")가 null이다(실측).
function bundledTagIconPath(): string | null {
    const il2cpp = Process.findModuleByName("libil2cpp.so");
    return il2cpp ? il2cpp.path.replace(/[^/]+$/, "libhwa_tag_icon.so") : null;
}
// 있는지만 보면 안 된다: 새로 깐 게임은 adb·비서 앱이 만든 공용 아이콘을 볼 수는 있어도 못 읽는다(2026-11-01 실측,
// 기존 .mod는 예전에 adb로 READ_MEDIA_IMAGES를 허용해 둬서 읽혔다). 못 읽은 경로를 주면 게임이 기본 ♫ 아이콘으로 바꾼다.
export function getTagIconPath(): string | null {
    for (const path of [PUBLIC_TAG_ICON_PATH, TAG_ICON_PATH, bundledTagIconPath()]) {
        if (path !== null && fileReadable(path)) return path;
    }
    return null;
}
