# [모더 학습 가이드] C# 모더를 위한 안드로이드 리버스 엔지니어링 & Frida 마스터 로드맵

**From C# to Native Reverse Engineering: The 4-Step Mastery Roadmap for Unity Android Modders**

- **작성자:** 화평 (화영왕)
- **대상 독자:** "PC에서 MelonLoader/Harmony로 C# 모딩은 해봤지만, 안드로이드의 오프셋·바이너리·ARM64 어셈블리·TypeScript는 낯선 모더"
- **핵심 목표:** `C# ➔ 정적 분석 ➔ 동적 분석 ➔ TypeScript` 4단계 정석 커리큘럼으로 안드로이드 IL2CPP 모딩 마스터하기

---

## 🧭 왜 C# 모더가 안드로이드에서 벽을 느끼는가?

PC 환경(Mono 또는 MelonLoader Il2Cpp 래퍼)에서는 컴파일러와 모드로더가 백그라운드에서 모든 번거로운 작업을 대신 처리해 줍니다:
```csharp
// PC C# 환경: 모든 타입과 심볼이 C# 객체로 포장되어 있음
[HarmonyPatch(typeof(Player), "TakeDamage")]
public static void Prefix(Player __instance, ref int damage) {
    if (__instance.isInvincible) damage = 0;
}
```
하지만 안드로이드 IL2CPP 환경으로 내려오면:
1. C# 코드는 흔적도 없이 사라지고 **ARM64 기계어 바이너리(`libil2cpp.so`)**만 남습니다.
2. `Player` 클래스는 그저 메모리 상의 **포인터(주소)**일 뿐입니다.
3. `isInvincible` 변수는 변수명이 아니라 `[x0 + 0x48]` 같은 **메모리 오프셋**으로 접근해야 합니다.

이 낯선 개념들 때문에 많은 C# 모더들이 "안드로이드는 내 영역이 아니다"라며 포기합니다.  
하지만 **원리만 알면 C# 지식이 그대로 안드로이드 모딩의 가장 강력한 무기**가 됩니다.  
아래의 4단계 학습 순서를 따라가면 누구나 자연스럽게 모바일 모더로 거듭날 수 있습니다.

---

# 📚 마스터 로드맵: 4단계 공부 순서

```
[STEP 1: C# 심화] ➔ Unity 메모리 모델(값 타입 vs 참조 타입, 힙 구조)의 본질 이해
       ▼
[STEP 2: 정적 분석] ➔ Il2CppDumper 주석 읽기 + il2cpp_asm.py로 어셈블리 쉽게 읽기
       ▼
[STEP 3: 동적 분석] ➔ Frida Interceptor로 런타임 메모리 주소/인자/반환값 직접 엿보기
       ▼
[STEP 4: TypeScript] ➔ frida-il2cpp-bridge로 PC Harmony처럼 직관적인 모드 완성
```

---

## STEP 1. C# 심화 & Unity 메모리 모델의 본질 이해

안드로이드 IL2CPP를 이해하려면 C# 코드가 메모리에서 실제로 어떻게 자리 잡는지 알아야 합니다.

### 1.1 값 타입(Value Type) vs 참조 타입(Reference Type)
* **참조 타입 (`class`)**:
  * 힙(Heap) 메모리에 할당되며, 우리가 다루는 변수는 **메모리 주소(포인터)**입니다.
  * 모든 IL2CPP 클래스 인스턴스는 맨 앞에 **16바이트 헤더**를 가집니다:
    * `+0x00`: `Il2CppClass*` (해당 객체의 클래스 정보 메타데이터 포인터)
    * `+0x08`: `MonitorData*` (스레드 동기화용 데이터 포인터)
    * `+0x10`: **여기서부터 실제 C# 필드 변수들이 시작됩니다!**
* **값 타입 (`struct`, `int`, `float`, `Vector3` 등)**:
  * 16바이트 헤더가 없습니다! 순수하게 데이터 바이트만 배열처럼 메모리에 나열됩니다.
  * *Muse Dash 실전 예시:* `MusicData`가 `struct`이므로, `List<MusicData>`는 힙 포인터 목록이 아니라 메모리에 0x160바이트씩 순차적으로 박혀 있습니다.

---

## STEP 2. 정적 분석 (Static Analysis & IL2CPP 심볼 복원)

앱을 실행하지 않고 덤프 파일과 바이너리를 분석하여 우리가 후킹할 함수의 위치와 필드 오프셋을 찾아내는 단계입니다.

### 2.1 Il2CppDumper 결과물(`dump.cs`) 읽는 법
Il2CppDumper를 돌리면 C# 형태의 `dump.cs`가 나옵니다. 여기서 주석을 해석할 수 있어야 합니다:

```csharp
// dump.cs 내부 발췌
public class MusicInfo // TypeDefIndex: 2841
{
    // Fields
    public string musicUid; // 0x18
    public string musicName; // 0x20
    public int unlockLevel; // 0xDC
    
    // Methods
    // RVA: 0x1CAC108 Offset: 0x1CAC108 VA: 0x1CAC108
    public void Init(int id) { }
}
```

* **`RVA: 0x1CAC108` (Relative Virtual Address, 상대 가상 주소)**:
  * `libil2cpp.so` 파일이 메모리에 로드되었을 때, **베이스 주소로부터 떨어진 거리**입니다.
  * 실제 메모리 주소 = `libil2cpp.so의 시작 주소 + 0x1CAC108`
* **`public int unlockLevel; // 0xDC` (Field Offset)**:
  * `MusicInfo` 인스턴스 포인터에서 **`+0xDC` (10진수로 220바이트)** 떨어진 메모리에 `int`형 `unlockLevel` 값이 저장되어 있다는 뜻입니다!

---

### 2.2 바이너리 어셈블리 날것으로 보지 말기: `il2cpp_asm.py` 활용

Ghidra나 IDA Pro 같은 거대한 역어셈블러는 안드로이드 ARM64 ELF를 열고 분석하는 데 한참 걸리며, C# 모더에게는 수만 줄의 어셈블리 코드가 공포로 다가옵니다.

이를 해결하기 위해 개발된 도구가 바로 **`il2cpp_asm.py`**입니다.  
이 도구는 `dump.cs`와 `script.json`을 읽어서, **어셈블리 코드 옆에 C# 메서드 이름과 문자열 주석을 친절하게 달아줍니다!**

#### 🛠️ 필수 라이브러리 설치
```bash
pip install capstone
```

#### 💻 `il2cpp_asm.py` 전체 소스 코드
아래 스크립트를 작업 폴더에 `tools/il2cpp_asm.py`로 저장하여 사용합니다:

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
il2cpp_asm — IL2CPP 메서드를 이름 주석이 달린 어셈블리로 출력합니다 (ARM64 · x64 / ELF · Mach-O · PE).
"""

import argparse
import bisect
import json
import os
import re
import struct
import sys

VERSION = "1.0"
MAX_FUNC = 0x4000
ADRP_WINDOW = 12

def die(msg, code=1):
    print(f"[il2cpp_asm] 오류: {msg}", file=sys.stderr)
    sys.exit(code)

CPU_ARM64, CPU_X86_64 = 0x0100000C, 0x01000007

def detect(blob, want_arch):
    if blob[:2] == b"MZ":
        pe = struct.unpack_from("<I", blob, 0x3C)[0]
        machine = struct.unpack_from("<H", blob, pe + 4)[0]
        arch = {0x8664: "x64", 0xAA64: "arm64"}.get(machine)
        if not arch: die(f"지원하지 않는 PE 머신 타입 0x{machine:X}")
        return arch, 0, "PE"
    if blob[:4] == b"\x7fELF":
        machine = struct.unpack_from("<H", blob, 0x12)[0]
        arch = {0xB7: "arm64", 0x3E: "x64"}.get(machine)
        if not arch: die(f"지원하지 않는 ELF 머신 타입 0x{machine:X} (ARM64 · x64만 지원)")
        return arch, 0, "ELF"
    die("PE 또는 ELF 형식이 아닙니다.")

class Symbols:
    def __init__(self, dump_cs, script_json):
        if not os.path.isfile(dump_cs): die(f"dump.cs가 없습니다: {dump_cs}")
        if not os.path.isfile(script_json): die(f"script.json이 없습니다: {script_json}")
        text = open(dump_cs, encoding="utf-8", errors="ignore").read()
        pairs = {}
        for m in re.finditer(r"// RVA: 0x([0-9A-Fa-f]+) Offset: 0x([0-9A-Fa-f]+) VA: 0x([0-9A-Fa-f]+)", text):
            pairs[int(m.group(1), 16)] = int(m.group(2), 16)
        if not pairs: die("dump.cs에서 RVA 주석을 찾지 못했습니다.")
        self.rvas = sorted(pairs)
        self.offsets = pairs

        d = json.load(open(script_json, encoding="utf-8"))
        self.methods, self.by_name, self.data, self.shared = {}, {}, {}, {}
        for x in d.get("ScriptMethod", []):
            self.methods.setdefault(x["Address"], x["Name"])
            self.shared.setdefault(x["Address"], set()).add(x["Name"])
            self.by_name.setdefault(x["Name"], []).append(x["Address"])
        for x in d.get("ScriptString", []):
            self.data.setdefault(x["Address"], "StringLiteral " + json.dumps(x["Value"], ensure_ascii=False)[:80])
        for key in ("ScriptMetadata", "ScriptMetadataMethod"):
            for x in d.get(key, []):
                self.data.setdefault(x["Address"], x["Name"])

    def file_offset(self, rva):
        if rva in self.offsets: return self.offsets[rva]
        i = bisect.bisect_right(self.rvas, rva) - 1
        return rva + (self.offsets[self.rvas[i]] - self.rvas[i]) if i >= 0 else None

    def end_of(self, rva):
        i = bisect.bisect_right(self.rvas, rva)
        nxt = self.rvas[i] if i < len(self.rvas) else rva + 0x400
        return min(nxt, rva + MAX_FUNC)

    def name_at(self, rva):
        if rva in self.methods:
            more = len(self.shared.get(rva, ())) - 1
            return self.methods[rva] + (f" (+{more}개 같은 주소)" if more > 0 else "")
        return self.data.get(rva)

    def find(self, classes, methods):
        hits = {}
        for cls in classes:
            got = [(a, n) for n, addrs in self.by_name.items() if n.startswith(cls + "$$") for a in addrs]
            hits.update({a: n for a, n in got if a not in hits})
        for q in methods:
            q = q.strip("'").replace("::", "$$")
            names = [q] if q in self.by_name else [n for n in self.by_name if n.split("$$", 1)[-1] == q]
            for n in names:
                for a in self.by_name[n]: hits.setdefault(a, n)
        return {a: n for a, n in hits.items() if a > 0}

def disasm_arm64(code, rva, start, end, sym):
    import capstone
    arch = getattr(capstone, "CS_ARCH_ARM64", None) or getattr(capstone, "CS_ARCH_AARCH64")
    md = capstone.Cs(arch, capstone.CS_MODE_ARM)
    pages, lines, named = {}, [], 0

    def reg(r): return "x" + r[1:] if r[:1] == "w" and r[1:].isdigit() else r

    for ins in md.disasm(code, rva):
        note = ""
        ops = [o.strip() for o in re.split(r",(?![^\[]*\])", ins.op_str)]
        mn = ins.mnemonic
        if mn in ("bl", "b") and ops and ops[0].startswith("#0x"):
            t = int(ops[0][1:], 16)
            if mn == "bl" or not (start <= t < end):
                n = sym.name_at(t)
                note = f"→ {n}" if n else f"→ sub_{t:X}"
                named += bool(n)
        elif mn == "adrp" and len(ops) == 2 and ops[1].startswith("#0x"):
            pages[reg(ops[0])] = (int(ops[1][1:], 16), ADRP_WINDOW)
        elif mn == "add" and len(ops) == 3 and reg(ops[1]) in pages and re.fullmatch(r"#(0x[0-9a-f]+|\d+)", ops[2]):
            v = pages[reg(ops[1])][0] + int(ops[2][1:], 0)
            n = sym.name_at(v)
            if n: note, named = f"&{n}", named + 1
            pages[reg(ops[0])] = (v, ADRP_WINDOW)
        elif mn.startswith(("ldr", "str")) and len(ops) >= 2:
            m = re.match(r"\[(\w+)(?:, #(0x[0-9a-f]+|\d+))?\]", ops[1])
            if m and reg(m.group(1)) in pages:
                v = pages[reg(m.group(1))][0] + (int(m.group(2), 0) if m.group(2) else 0)
                n = sym.name_at(v)
                if n: note, named = f"[{n}]", named + 1
            if mn.startswith("ldr"): pages.pop(reg(ops[0]), None)
        pages = {k: (v, left - 1) for k, (v, left) in pages.items() if left > 1}
        lines.append(f"{ins.address:#010x}  {mn:<8}{ins.op_str}" + (f"    ; {note}" if note else ""))
    return lines, named

def main():
    ap = argparse.ArgumentParser(description="IL2CPP 메서드 주석 디스어셈블러")
    ap.add_argument("--binary", required=True, help="libil2cpp.so 경로")
    ap.add_argument("--dump", required=True, help="dump.cs 경로")
    ap.add_argument("--script-json", required=True, help="script.json 경로")
    ap.add_argument("--method", dest="methods", action="append", default=[], help="분석할 메서드 (예: MusicInfo::Init)")
    ap.add_argument("--out", help="출력 파일 경로")
    a = ap.parse_args()

    import capstone
    blob = open(a.binary, "rb").read()
    arch, base_off, fmt = detect(blob, "arm64")
    sym = Symbols(a.dump, a.script_json)
    targets = sym.find([], a.methods)
    
    for rva in sorted(targets):
        end = sym.end_of(rva)
        fo = sym.file_offset(rva)
        code = blob[base_off + fo: base_off + fo + (end - rva)]
        lines, _ = disasm_arm64(code, rva, rva, end, sym)
        print(f"\n; ===== {targets[rva]}  RVA {rva:#x}")
        print("\n".join(lines))

if __name__ == "__main__":
    main()
```

#### 🚀 사용 방법 및 결과 읽기
```bash
python tools/il2cpp_asm.py --binary libil2cpp.so --dump dump.cs --script-json script.json --method "MusicInfo::Init"
```

**출력 결과 예시:**
```armasm
; ===== MusicInfo$$Init  RVA 0x1cac108
0x01cac108  stp     x20, x19, [sp, #-0x20]!
0x01cac10c  str     x30, [sp, #0x10]
0x01cac110  mov     x19, x0                 ; x19 = this (MusicInfo 인스턴스)
0x01cac114  mov     w20, w1                 ; w20 = id 인자
0x01cac118  bl      #0x1bcbb24              ; → ItemManager$$GetItemInfo
0x01cac120  str     w0, [x19, #0xdc]        ; this.unlockLevel = w0 (필드 오프셋 0xDC에 저장!)
0x01cac124  ldr     x30, [sp, #0x10]
0x01cac128  ldp     x20, x19, [sp], #0x20
0x01cac12c  ret
```
> **💡 핵심:** 어셈블리 전체를 해석할 필요가 없습니다!  
> `bl` 뒤에 붙은 **`→ 메서드이름`**과 `[x19, #0xdc]`처럼 **어떤 필드 오프셋에 값을 쓰는지**만 주석으로 확인하면 함수의 내부 동작을 10초 만에 꿰뚫어 볼 수 있습니다.

---

## STEP 3. 동적 분석 (Dynamic Instrumentation & Memory Inspection)

정적 분석으로 함수 위치(RVA)와 오프셋을 알았다면, 이제 앱을 켜두고 **실제 메모리에 들어오는 값들을 실시간으로 관찰**합니다.

### 3.1 ARM64 호출 규약(Calling Convention) 핵심 공식
ARM64에서는 함수가 호출될 때 인자들이 CPU 레지스터에 순서대로 담깁니다:
* **`x0` (args[0])**: 인스턴스 메서드인 경우 **`this` 포인터** (정적 메서드는 1번째 인자)
* **`x1` (args[1])**: C# 메서드의 1번째 매개변수
* **`x2` (args[2])**: C# 메서드의 2번째 매개변수
* **`x0` (retval)**: 함수가 종료(`onLeave`)될 때의 **반환값**

### 3.2 Frida Interceptor 실전 코드 스니펫
```typescript
// libil2cpp.so의 모듈 베이스 주소 구하기
const base = Module.findBaseAddress("libil2cpp.so")!;

// MusicInfo::Init (RVA: 0x1CAC108) 후킹
Interceptor.attach(base.add(0x1CAC108), {
    onEnter(args) {
        const self = args[0]; // this 포인터
        const id = args[1].toInt32(); // 1번째 인자 (id)
        
        console.log(`[Init 진입] this 주소: ${self}, 곡 id: ${id}`);
    },
    onLeave(retval) {
        // 함수가 끝난 직후 this.unlockLevel (오프셋 0xDC)을 강제로 0으로 변경!
        // this 포인터를 기억해 두었다가 수정
    }
});
```

---

## STEP 4. TypeScript & Frida Gadget 실전 이식

저수준 오프셋과 메모리 개념을 이해했다면, 이제 마지막 단계인 **TypeScript 고수준 모드 작성**으로 넘어갑니다.

### 4.1 C# 모더에게 TypeScript가 친숙한 이유
* TypeScript는 C#의 아버지인 아네르스 하일스베르(Anders Hejlsberg)가 설계하여, C#과 문법 구조(인터페이스, 제네릭, 강타입, async/await)가 80% 이상 유사합니다.
* `frida-il2cpp-bridge`를 사용하면 저수준 RVA나 바이트 오프셋 계산을 라이브러리가 대신 처리해 줍니다!

### 4.2 C# Harmony vs TypeScript Frida 1:1 비교
```typescript
// C# Harmony처럼 클래스와 메서드를 이름으로 직접 찾아서 후킹!
Il2Cpp.perform(() => {
    // 1. 도메인에서 클래스 찾기
    const MusicInfo = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("MusicInfo");
    
    // 2. 메서드 구현 가로채기
    MusicInfo.method("Init").implementation = function (id: number) {
        // 원본 호출
        this.method("Init").invoke(id);
        
        // C# 필드명으로 직접 값 수정 (내부적으로 0xDC 오프셋 자동 계산)
        this.field("unlockLevel").value = 0;
        
        console.log(`[Mod] 곡 ID ${id}의 잠금이 해제되었습니다.`);
    };
});
```

---

## 🎯 학습 로드맵 요약 가이드라인

1. **C# 구조체/클래스 메모리 차이**를 먼저 이해하라 (포인터 개념 잡기).
2. 무거운 디스어셈블러 대신 **`il2cpp_asm.py`**로 관심 있는 메서드의 주석 달린 어셈블리를 가볍게 훑어라.
3. Frida `Interceptor.attach`로 `args[0]`(this)과 오프셋을 직접 콘솔에 찍어보며 **동적 감각**을 익혀라.
4. 최종 모드 코드는 **`frida-il2cpp-bridge`**를 통해 C#처럼 깔끔한 TypeScript로 빌드하라.

이 순서대로 접근하면, C# 배경을 가진 모더 누구나 며칠 만에 안드로이드 Unity IL2CPP를 자유자재로 다루는 전문 모더로 성장할 수 있습니다.
