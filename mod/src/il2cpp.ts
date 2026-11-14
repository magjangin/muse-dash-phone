// IL2CPP 공용 헬퍼. 모듈마다 복사돼 있던 클래스 찾기·배열 만들기를 한곳에 모았다(2026-11-13 리팩토링).
// 모두 호출될 때만 IL2CPP를 건드린다(모듈 로드 때는 아무것도 하지 않음) → Il2Cpp.perform 전에 import해도 안전하다.

/** Il2Cpp 배열 머리: 길이(u32) @0x18, 첫 원소 @0x20 (arm64). */
export const ARRAY_LENGTH = 0x18;
export const ARRAY_DATA = 0x20;

/** 게임 코드 어셈블리(Assembly-CSharp) 이미지. */
export function gameImage(): Il2Cpp.Image {
    return Il2Cpp.domain.assembly("Assembly-CSharp").image;
}

/** Assembly-CSharp의 클래스. 없으면 예외. */
export function gameClass(name: string): Il2Cpp.Class {
    return gameImage().class(name);
}

/** 지정한 어셈블리(UnityEngine.CoreModule 등)의 클래스. 없으면 예외. */
export function unityClass(assembly: string, name: string): Il2Cpp.Class {
    return Il2Cpp.domain.assembly(assembly).image.class(name);
}

/** 모든 어셈블리에서 이름으로 찾는다(네임스페이스 포함 전체 이름). 없으면 null. */
export function findClass(name: string): Il2Cpp.Class | null {
    for (const a of Il2Cpp.domain.assemblies) {
        const k = a.image.tryClass(name);
        if (k) return k;
    }
    return null;
}

/** findClass와 같되 없으면 예외. */
export function requireClass(name: string): Il2Cpp.Class {
    const k = findClass(name);
    if (!k) throw new Error(`클래스 없음: ${name}`);
    return k;
}

/** UnityEngine.Color 값. ValueType은 `.new()`가 아니라 `alloc().unbox()`로 만든다(인자 없는 new는 필드 수 오류). */
export function makeColor(r: number, g: number, b: number, a: number): Il2Cpp.ValueType {
    const color = unityClass("UnityEngine.CoreModule", "UnityEngine.Color").alloc().unbox();
    color.field<number>("r").value = r;
    color.field<number>("g").value = g;
    color.field<number>("b").value = b;
    color.field<number>("a").value = a;
    return color;
}

/** UnityEngine.Vector2 값. */
export function makeVector2(x: number, y: number): Il2Cpp.ValueType {
    const v = unityClass("UnityEngine.CoreModule", "UnityEngine.Vector2").alloc().unbox();
    v.field<number>("x").value = x;
    v.field<number>("y").value = y;
    return v;
}

export const isNull =(p: NativePointer | null | undefined): boolean => !p || p.isNull();

/** 파일 바이트 → System.Byte[] (ImageConversion.LoadImage 인자용). */
export function byteArrayFromFile(path: string): Il2Cpp.Array<number> {
    const bytes = new Uint8Array(File.readAllBytes(path));
    const array = Il2Cpp.array<number>(Il2Cpp.corlib.class("System.Byte"), bytes.length);
    array.handle.add(ARRAY_DATA).writeByteArray(bytes.buffer as ArrayBuffer);
    return array;
}
