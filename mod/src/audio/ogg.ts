// OGG 길이(채널당 총 샘플 수)를 파일 끝 페이지에서 바로 읽는다 (customAudio.ts에서 분리, 2026-11-13).
import { regularFileSize } from "../native.js";

const OGG_TAIL_BYTES = 65536;

/** OGG 파일의 마지막 페이지 granule = 채널당 총 샘플 수. 못 읽으면 -1. */
export function oggTotalSamples(path: string): number {
    const size = regularFileSize(path);
    if (size < 64) return -1;
    const from = Math.max(0, size - OGG_TAIL_BYTES);
    const f = new File(path, "rb");
    let tail: Uint8Array;
    try {
        f.seek(from, File.SEEK_SET);   // SEEK_CUR는 Frida 17.24.3에서 버퍼 위치 기준으로 어긋난다(AGENTS Dead End)
        tail = new Uint8Array(f.readBytes(size - from));
    } finally {
        f.close();
    }
    // 뒤에서부터 "OggS" + version 0 인 페이지 머리를 찾는다. 페이지 길이가 파일 끝을 넘지 않아야 진짜 머리로 본다.
    for (let i = tail.length - 27; i >= 0; i--) {
        if (tail[i] !== 0x4f || tail[i + 1] !== 0x67 || tail[i + 2] !== 0x67 || tail[i + 3] !== 0x53 || tail[i + 4] !== 0) continue;
        const segments = tail[i + 26];
        if (i + 27 + segments > tail.length) continue;
        let body = 0;
        for (let k = 0; k < segments; k++) body += tail[i + 27 + k];
        if (i + 27 + segments + body > tail.length) continue;
        let granule = 0;
        for (let k = 7; k >= 0; k--) granule = granule * 256 + tail[i + 6 + k];
        if (granule <= 0 || granule > 0x7fffffff) continue;   // -1(완성 패킷 없음)·비정상은 그 앞 페이지로
        return granule;
    }
    return -1;
}
