// 가상 곡(1999-N, 숙주 MusicInfo 얕은 복제)·가상 앨범 만들기와 그 조회 표 (customTag.ts에서 분리, 2026-11-13).
import { log } from "../log.js";
import { pinnedString, readIl2CppString } from "../native.js";
import { gameClass } from "../il2cpp.js";
import { hasMapForLevel } from "../hwa/chartFiles.js";
import { ALBUM_UID, FALLBACK_HOST_UID, TAG_INDEX, TAG_UID } from "../hwa/library.js";
import type { HwaSong } from "../hwa/library.js";

export const ALBUM_TITLE = "실험 앨범";
const ALBUM_JSON_NAME = "custom_album_1998_0";   // 가상 앨범(AlbumsInfo.jsonName) 표시용
const ALBUM_PREFAB = "album_0";

// MusicInfo 오프셋 (dump.cs). MusicExInfo는 0xE8에 값으로 박힌 struct라 MemberwiseClone이 그대로 복사한다.
const MI = {
    listIndex: 0x10,         // BaseDataObject.<listIndex>k__BackingField — 앨범 현지화 표 행 번호
    uid: 0x20, name: 0x28, author: 0x30, music: 0x40, demo: 0x48, cover: 0x50, levelDesigner: 0x70,
    difficulty: [0xA0, 0xA8, 0xB0, 0xB8, 0xC0], callBackDifficulty: [0xC8, 0xCC, 0xD0, 0xD4, 0xD8],
    exAlbumIndex: 0xE8,      // get_albumJsonIndex 가 읽음 (숙주 값 유지)
    exAlbumUidIndex: 0xEC,   // get_albumIndex 가 읽음
    exAlbumUidName: 0xF8,    // get_albumUidName 이 먼저 봄
    exAlbumJsonName: 0x100
};

const cls = gameClass;

function setStr(obj: Il2Cpp.Object, offset: number, value: string | null): void {
    obj.handle.add(offset).writePointer(value === null ? NULL : pinnedString(value));
}

// 가상 곡 → 화면 제목·작곡가. 곡 선택 화면은 GetLocal을 거치지 않고 DBConfigLocalALBUM.GetLocalAlbumInfoByIndex(listIndex)로
// 숙주 앨범 현지화 표의 행을 직접 읽는다(PC 모드 문서의 '두 겹 조회'). 가상 곡마다 표에 없는 고유 행 번호를 주고 그 번호로 답한다.
export const VIRTUAL_LIST_INDEX_BASE = 100000;
export const localByClone = new Map<string, Il2Cpp.Object>();
export const localByListIndex = new Map<number, Il2Cpp.Object>();
// 가상 앨범 라벨: 앨범도 표에 없는 고유 행 번호를 주고 그 번호의 제목만 답한다. 가상 곡의 앨범 조회는 가상 앨범으로.
export const VIRTUAL_ALBUM_LIST_INDEX = VIRTUAL_LIST_INDEX_BASE;
export const virtualClones = new Set<string>();

// 가상 곡 에셋: cover/music/demo 키를 곡마다 고유 이름(hwa_<종류>_1999-N)으로 바꾸고, LoadFromName이 그 이름을 요청하면
// 원본에는 숙주 에셋 이름을 넘겨(없는 에셋 요청 예외 방지) 끝나면 곡 폴더 파일로 만든 Sprite/AudioClip으로 바꾼다.
// 곡 선택 화면에선 m_MusicUid가 비어 있어(배틀 시작 때 정해짐) uid로는 고를 수 없다 → 에셋 키로 고른다.
export type AssetKind = "cover" | "music" | "demo";
export const assetRequests = new Map<string, { kind: AssetKind; song: HwaSong; hostName: string }>();
export const assetCache = new Map<string, Il2Cpp.Object>();
export const hostMusicNames = new Set<string>();
export const assetKey = (kind: AssetKind, song: HwaSong) => `hwa_${kind}_${song.virtualUid}`;

export function makeVirtualSong(db: Il2Cpp.Object, song: HwaSong): Il2Cpp.Object | null {
    const hostUid = song.manifest.uid || FALLBACK_HOST_UID;
    let host = db.method<Il2Cpp.Object>("GetMusicInfoFromAll").invoke(Il2Cpp.string(hostUid));
    if (!host || host.isNull()) {
        log({ t: "tag-host-missing", song: song.name, hostUid, fallback: FALLBACK_HOST_UID });
        host = db.method<Il2Cpp.Object>("GetMusicInfoFromAll").invoke(Il2Cpp.string(FALLBACK_HOST_UID));
        if (!host || host.isNull()) return null;
    }
    const clone = host.method<Il2Cpp.Object>("MemberwiseClone").invoke();
    clone.ref(true);

    // 아래에서 난이도 칸을 info.txt 값으로 덮기 전에, 숙주에 실제로 있는 차트 에셋을 기억한다.
    song.hostMaps = MI.difficulty.flatMap((offset, i) => {
        const level = readIl2CppString(host!.handle.add(offset).readPointer());
        return hasMapForLevel(level) ? [i + 1] : [];
    });

    const m = song.manifest;
    const index = VIRTUAL_LIST_INDEX_BASE + localByListIndex.size + 1;
    const hostAsset = (field: string) => host!.field<Il2Cpp.String>(field).value?.content ?? null;
    const title = m.customTitle || m.title || `화영왕 ${song.virtualUid.substring(5)}`;
    const author = m.customArtist || m.artist || `화영왕 ${song.virtualUid.substring(5)}`;
    setStr(clone, MI.uid, song.virtualUid);
    setStr(clone, MI.name, title);
    setStr(clone, MI.author, author);
    setStr(clone, MI.levelDesigner, m.levelDesigner || author);
    clone.handle.add(MI.listIndex).writeS32(index);
    // music 키는 숙주 것 그대로 둔다: 배틀 시작 때 HotfixSystem이 music 키로 트랙 에셋을 확인·다운로드해서, 모르는 키면
    // "데이터 다운로드를 실패했어요"로 시작이 막힌다(2026-10-31 실측). 본곡은 배틀 때 m_MusicUid로 골라 바꾼다(아래).
    const hostMusic = hostAsset("music");
    if (hostMusic) hostMusicNames.add(hostMusic);
    const swaps: [AssetKind, number, string | null][] = [
        ["cover", MI.cover, song.coverPath], ["demo", MI.demo, song.musicPath]
    ];
    for (const [kind, offset, path] of swaps) {
        const hostName = hostAsset(kind);
        if (!path || !hostName) continue;
        setStr(clone, offset, assetKey(kind, song));
        assetRequests.set(assetKey(kind, song), { kind, song, hostName });
    }
    // 난이도 필드는 문자열. music/noteJson/cover 에셋 키는 숙주 것을 물려받는다(음원·차트는 배틀 때 따로 교체).
    const diffs = [m.difficulty1, m.difficulty2, m.difficulty3, m.difficulty4, m.difficulty5].map(d => (d == null ? 0 : d));
    diffs.forEach((d, i) => {
        setStr(clone, MI.difficulty[i], String(d));
        clone.handle.add(MI.callBackDifficulty[i]).writeS32(d);
    });
    // 앨범 json 번호(m_AlbumIndex, ALBUM<n> 설정 파일)는 숙주 것을 그대로 둔다. PC처럼 2000으로 바꾸면 GetLocal 등이
    // 없는 ALBUM2000을 찾다 예외를 던지고, Frida 훅 프레임을 못 넘어가 게임이 죽는다(logs/18_logcat.log, 2026-10-31).
    clone.handle.add(MI.exAlbumUidIndex).writeS32(TAG_INDEX);
    setStr(clone, MI.exAlbumUidName, ALBUM_UID);

    const local = cls("Assets.Scripts.Database.LocalALBUMInfo").new();
    local.field<Il2Cpp.String>("name").value = Il2Cpp.string(title);
    local.field<Il2Cpp.String>("author").value = Il2Cpp.string(author);
    local.ref(true);
    localByClone.set(clone.handle.toString(), local);
    virtualClones.add(clone.handle.toString());
    localByListIndex.set(index, local);

    const all = db.field<Il2Cpp.Object>("m_AllMusicInfo").value;
    all.method("set_Item").invoke(Il2Cpp.string(song.virtualUid), clone);
    const check = db.method<Il2Cpp.Object>("GetMusicInfoFromAll").invoke(Il2Cpp.string(song.virtualUid));
    const ok = !!check && !check.isNull() && check.handle.equals(clone.handle);
    log({ t: "tag-virtual-song", uid: song.virtualUid, host: hostUid, hostMaps: song.hostMaps, title, diffs, listIndex: index, assets: swaps.filter(([k]) => assetRequests.has(assetKey(k, song))).map(([k]) => k), ok });
    return ok ? clone : null;
}

export function makeAlbum(): Il2Cpp.Object | null {
    const configManager = cls("Assets.Scripts.PeroTools.Managers.ConfigManager").method<Il2Cpp.Object>("get_instance").invoke();
    const albumsClass = cls("Assets.Scripts.Database.DBConfigAlbums");
    const albums = configManager.method<Il2Cpp.Object>("GetConfigObject", 1).inflate(albumsClass).invoke(-1);
    if (!albums || albums.isNull()) return null;
    const items = albums.field<Il2Cpp.Object>("m_Items").value;
    const count = items.method<number>("get_Count").invoke();
    for (let i = 0; i < count; i++) {
        const it = items.method<Il2Cpp.Object>("get_Item").invoke(i);
        if (it.field<Il2Cpp.String>("uid").value?.content === ALBUM_UID) return it;   // 스크립트 재로드 시 중복 방지
    }
    const album = items.method<Il2Cpp.Object>("get_Item").invoke(0).method<Il2Cpp.Object>("MemberwiseClone").invoke();
    album.ref(true);
    album.field<Il2Cpp.String>("uid").value = Il2Cpp.string(ALBUM_UID);
    album.field<Il2Cpp.String>("title").value = Il2Cpp.string(ALBUM_TITLE);
    album.field<Il2Cpp.String>("tag").value = Il2Cpp.string(TAG_UID);
    album.field<Il2Cpp.String>("jsonName").value = Il2Cpp.string(ALBUM_JSON_NAME);
    album.field<Il2Cpp.String>("prefabsName").value = Il2Cpp.string(ALBUM_PREFAB);
    album.field<boolean>("needPurchase").value = false;
    album.field<boolean>("free").value = true;
    album.handle.add(album.class.field("pay_ids").offset).writePointer(NULL);
    album.handle.add(MI.listIndex).writeS32(VIRTUAL_ALBUM_LIST_INDEX);   // BaseDataObject.listIndex — 앨범 제목 현지화 행
    items.method("Add").invoke(album);
    return album;
}
