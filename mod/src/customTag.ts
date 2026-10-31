// 커스텀 태그 "실험 모드" + 가상 앨범(1999-0) + 가상 곡(1999-N, 숙주 곡 MusicInfo 얕은 복제) 주입.
// PC 모드 Patches/UI/Custom/Tags/CustomTagRegistry.cs + Support/CustomTagRegistrySupport.cs + CustomTagPatch.cs 이식본.
// 게임 자체의 커스텀 태그 구조(DBConfigCustomTags.CustomTagInfo → AlbumTagInfo.InitCustomTagInfo → DBMusicTag.AddAlbumTagData)를 그대로 쓴다.
import { MOD_DIR, guard, log } from "./log.js";
import { fileExists, pinnedString } from "./native.js";
import { ALBUM_UID, FALLBACK_HOST_UID, TAG_INDEX, TAG_UID, allSongs } from "./hwa/library.js";
import type { HwaSong } from "./hwa/library.js";
import { currentCustomSong, setBattleAudioLength } from "./customChart.js";

function findClass(name: string): Il2Cpp.Class | null {
    for (const a of Il2Cpp.domain.assemblies) {
        const k = a.image.tryClass(name);
        if (k) return k;
    }
    return null;
}

const ALBUM_TITLE = "실험 앨범";
const ALBUM_JSON_NAME = "custom_album_1998_0";   // 가상 앨범(AlbumsInfo.jsonName) 표시용
const ALBUM_PREFAB = "album_0";
const PUBLIC_TAG_ICON_PATH = "/storage/emulated/0/MuseDash/hwa_tag_icon.png";
const TAG_ICON_PATH = `${MOD_DIR}/hwa_tag_icon.png`;
function getTagIconPath(): string | null {
    if (fileExists(PUBLIC_TAG_ICON_PATH)) return PUBLIC_TAG_ICON_PATH;
    if (fileExists(TAG_ICON_PATH)) return TAG_ICON_PATH;
    return null;
}
const TAG_NAMES: [string, string][] = [
    ["Korean", "실험 모드"], ["English", "Experiment Mod"], ["Japanese", "実験モード"],
    ["ChineseSimplified", "实验模式"], ["ChineseTraditional", "實驗模式"]
];

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

const image = () => Il2Cpp.domain.assembly("Assembly-CSharp").image;
const cls = (name: string) => image().class(name);

function newList(element: Il2Cpp.Class, items: (Il2Cpp.Object | Il2Cpp.String)[]): Il2Cpp.Object {
    const list = Il2Cpp.corlib.class("System.Collections.Generic.List`1").inflate(element).new();
    for (const it of items) list.method("Add").invoke(it);
    list.ref(true);
    return list;
}

function stringList(values: string[]): Il2Cpp.Object {
    return newList(Il2Cpp.corlib.class("System.String"), values.map(v => Il2Cpp.string(v)));
}

function musicTagDb(): Il2Cpp.Object {
    return cls("Assets.Scripts.Database.GlobalDataBase").field<Il2Cpp.Object>("s_DbMusicTag").value;
}

function setStr(obj: Il2Cpp.Object, offset: number, value: string | null): void {
    obj.handle.add(offset).writePointer(value === null ? NULL : pinnedString(value));
}

// 가상 곡 → 화면 제목·작곡가. 곡 선택 화면은 GetLocal을 거치지 않고 DBConfigLocalALBUM.GetLocalAlbumInfoByIndex(listIndex)로
// 숙주 앨범 현지화 표의 행을 직접 읽는다(PC 모드 문서의 '두 겹 조회'). 가상 곡마다 표에 없는 고유 행 번호를 주고 그 번호로 답한다.
const VIRTUAL_LIST_INDEX_BASE = 100000;
const localByClone = new Map<string, Il2Cpp.Object>();
const localByListIndex = new Map<number, Il2Cpp.Object>();
// 가상 앨범 라벨: 앨범도 표에 없는 고유 행 번호를 주고 그 번호의 제목만 답한다. 가상 곡의 앨범 조회는 가상 앨범으로.
const VIRTUAL_ALBUM_LIST_INDEX = VIRTUAL_LIST_INDEX_BASE;
const virtualClones = new Set<string>();
let virtualAlbum: Il2Cpp.Object | null = null;

// 가상 곡 에셋: cover/music/demo 키를 곡마다 고유 이름(hwa_<종류>_1999-N)으로 바꾸고, LoadFromName이 그 이름을 요청하면
// 원본에는 숙주 에셋 이름을 넘겨(없는 에셋 요청 예외 방지) 끝나면 곡 폴더 파일로 만든 Sprite/AudioClip으로 바꾼다.
// 곡 선택 화면에선 m_MusicUid가 비어 있어(배틀 시작 때 정해짐) uid로는 고를 수 없다 → 에셋 키로 고른다.
type AssetKind = "cover" | "music" | "demo";
const assetRequests = new Map<string, { kind: AssetKind; song: HwaSong; hostName: string }>();
const assetCache = new Map<string, Il2Cpp.Object>();
const assetKey = (kind: AssetKind, song: HwaSong) => `hwa_${kind}_${song.virtualUid}`;

function makeVirtualSong(db: Il2Cpp.Object, song: HwaSong): Il2Cpp.Object | null {
    const hostUid = song.manifest.uid || FALLBACK_HOST_UID;
    let host = db.method<Il2Cpp.Object>("GetMusicInfoFromAll").invoke(Il2Cpp.string(hostUid));
    if (!host || host.isNull()) {
        log({ t: "tag-host-missing", song: song.name, hostUid, fallback: FALLBACK_HOST_UID });
        host = db.method<Il2Cpp.Object>("GetMusicInfoFromAll").invoke(Il2Cpp.string(FALLBACK_HOST_UID));
        if (!host || host.isNull()) return null;
    }
    const clone = host.method<Il2Cpp.Object>("MemberwiseClone").invoke();
    clone.ref(true);

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
    log({ t: "tag-virtual-song", uid: song.virtualUid, host: hostUid, title, diffs, listIndex: index, assets: swaps.filter(([k]) => assetRequests.has(assetKey(k, song))).map(([k]) => k), ok });
    return ok ? clone : null;
}

function makeAlbum(): Il2Cpp.Object | null {
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

function registerTag(): void {
    const songs = allSongs();
    if (songs.length === 0) return;
    const db = musicTagDb();
    if (!db || db.isNull()) {
        log({ t: "tag-skip", reason: "DBMusicTag 없음" });
        return;
    }

    const uids: string[] = [];
    for (const s of songs) {
        guard(`tag-song-${s.name}`, () => { if (makeVirtualSong(db, s)) uids.push(s.virtualUid); });
    }

    const languages = Il2Cpp.corlib.class("System.Collections.Generic.Dictionary`2")
        .inflate(Il2Cpp.corlib.class("System.String"), Il2Cpp.corlib.class("System.String")).new();
    for (const [lang, name] of TAG_NAMES) languages.method("set_Item").invoke(Il2Cpp.string(lang), Il2Cpp.string(name));
    languages.ref(true);

    const custom = cls("Assets.Scripts.Database.DBConfigCustomTags").nested("CustomTagInfo").new();
    custom.ref(true);
    custom.field<Il2Cpp.Object>("tag_name").value = languages;
    // LoadImg는 URL로 읽는다(그냥 경로를 주면 http://localhost 로 접속하려다 실패) → file:// 를 붙인다.
    const iconPath = getTagIconPath();
    if (iconPath) custom.field<Il2Cpp.String>("tag_picture").value = Il2Cpp.string(`file://${iconPath}`);
    custom.field<Il2Cpp.Object>("music_list").value = stringList(uids);

    const tag = cls("Assets.Scripts.Database.DataClass.AlbumTagInfo").new();
    tag.ref(true);
    tag.field<Il2Cpp.String>("name").value = Il2Cpp.string("Experiment Mod");
    tag.field<Il2Cpp.String>("tagUid").value = Il2Cpp.string(TAG_UID);
    tag.field<Il2Cpp.String>("iconName").value = Il2Cpp.string("IconCustomAlbums");
    tag.method("InitCustomTagInfo").invoke(custom);
    tag.method("SetTagUids").invoke(stringList(uids));

    const album = makeAlbum();
    virtualAlbum = album;
    if (album) {
        const albumsInfoClass = cls("Assets.Scripts.Database.DBConfigAlbums").nested("AlbumsInfo");
        tag.field<Il2Cpp.Object>("m_AlbumsInfos").value = newList(albumsInfoClass, [album]);
        const displayClass = cls("Assets.Scripts.Database.AlbumDisplayMusic");
        const display = displayClass.alloc();
        display.method(".ctor").overload(albumsInfoClass).invoke(album);
        display.method("AddRangeMusicUid").invoke(stringList(uids));
        display.ref(true);
        tag.field<Il2Cpp.Object>("m_DisplayMusicUids").value = newList(displayClass, [display]);
    }
    tag.field<Il2Cpp.Object>("m_MusicUids").value = stringList(uids);

    if (!db.method<boolean>("AllAlbumTagsSortContains").invoke(TAG_INDEX)) db.method("AddCustomAlbumTagsSort").invoke(TAG_INDEX);
    db.method("AddAlbumTagData").invoke(TAG_INDEX, tag);
    log({ t: "tag-registered", tagIndex: TAG_INDEX, songs: uids, album: !!album, icon: !!getTagIconPath() });
}

function unityClass(assembly: string, name: string): Il2Cpp.Class {
    return Il2Cpp.domain.assembly(assembly).image.class(name);
}

/** PNG/JPG 파일 → Sprite (Texture2D + ImageConversion.LoadImage + Sprite.Create). 실패하면 null. */
function spriteFromFile(path: string): Il2Cpp.Object | null {
    const bytes = new Uint8Array(File.readAllBytes(path));
    const array = Il2Cpp.array<number>(Il2Cpp.corlib.class("System.Byte"), bytes.length);
    array.handle.add(0x20).writeByteArray(bytes.buffer as ArrayBuffer);
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
    const sprite = unityClass("UnityEngine.CoreModule", "UnityEngine.Sprite").method<Il2Cpp.Object>("Create")
        .overload("UnityEngine.Texture2D", "UnityEngine.Rect", "UnityEngine.Vector2").invoke(tex, rect, pivot);
    if (!sprite || sprite.isNull()) return null;
    tex.ref(true);
    sprite.ref(true);
    // 씬 전환 때 Resources.UnloadUnusedAssets에 지워지지 않게 한다.
    sprite.method("set_hideFlags").invoke(32);   // HideFlags.DontUnloadUnusedAsset
    tex.method("set_hideFlags").invoke(32);
    return sprite;
}

export function installCustomTag(): void {
    const tagManager = cls("MusicTagManager");

    // 앨범 태그 목록을 만드는 자리 뒤에 우리 태그를 붙인다 (PC: InitAlbumTagInfo Postfix).
    Interceptor.attach(tagManager.method("InitAlbumTagInfo").virtualAddress, {
        onLeave() { guard("tag-register", registerTag); }
    });

    // 태그 번호가 큰 값(1999)이면 RefreshStageDisplayMusics가 NRE를 낸다 → 우리 태그(와 -1)는 건너뛴다 (PC 동일).
    const refresh = tagManager.method("RefreshStageDisplayMusics", 1);
    refresh.implementation = function (this: Il2Cpp.Object, tagIndex: number) {
        if (tagIndex === TAG_INDEX || tagIndex === -1) return;
        return this.method("RefreshStageDisplayMusics", 1).invoke(tagIndex);
    } as any;

    // 가상 곡 제목·작곡가: GetLocal(언어)이 숙주 곡 현지화 행을 돌려주므로 가상 곡이면 원본을 아예 부르지 않고 우리 LocalALBUMInfo를 준다.
    // (원본을 부른 뒤 반환만 바꾸면, 원본이 던진 예외가 Frida 프레임을 못 넘어가 abort된다.)
    const getLocalAddr = cls("Assets.Scripts.Database.MusicInfo").method("GetLocal").virtualAddress;
    const getLocalOriginal = new NativeFunction(getLocalAddr, "pointer", ["pointer", "int", "pointer"]);
    Interceptor.replace(getLocalAddr, new NativeCallback((self: NativePointer, language: number, method: NativePointer) => {
        const local = localByClone.get(self.toString());
        if (local) return local.handle;
        return getLocalOriginal(self, language, method) as NativePointer;
    }, "pointer", ["pointer", "int", "pointer"]));
    // 제목: 고유 행 번호(100000+)면 원본을 부르지 않고 우리 LocalALBUMInfo를 준다. 나머지는 원본 그대로.
    const byIndexAddr = cls("Assets.Scripts.Database.DBConfigLocalALBUM").method("GetLocalAlbumInfoByIndex").virtualAddress;
    const byIndexOriginal = new NativeFunction(byIndexAddr, "pointer", ["pointer", "int", "pointer"]);
    Interceptor.replace(byIndexAddr, new NativeCallback((self: NativePointer, index: number, method: NativePointer) => {
        const local = index >= VIRTUAL_LIST_INDEX_BASE ? localByListIndex.get(index) : undefined;
        if (local) return local.handle;
        return byIndexOriginal(self, index, method) as NativePointer;
    }, "pointer", ["pointer", "int", "pointer"]));

    // 앨범 라벨: 가상 곡이면 가상 앨범을, 가상 앨범 행 번호면 "실험 앨범"을 (원본은 안 부름).
    const byMusicAddr = cls("Assets.Scripts.Database.DBConfigAlbums").method("GetAlbumInfoByMusicInfo", 1).virtualAddress;
    const byMusicOriginal = new NativeFunction(byMusicAddr, "pointer", ["pointer", "pointer", "pointer"]);
    Interceptor.replace(byMusicAddr, new NativeCallback((self: NativePointer, info: NativePointer, method: NativePointer) => {
        if (virtualAlbum && virtualClones.has(info.toString())) return virtualAlbum.handle;
        return byMusicOriginal(self, info, method) as NativePointer;
    }, "pointer", ["pointer", "pointer", "pointer"]));
    const albumTitleAddr = cls("Assets.Scripts.Database.DBConfigLocalAlbums").method("GetLocalTitleByIndex", 1).virtualAddress;
    const albumTitleOriginal = new NativeFunction(albumTitleAddr, "pointer", ["pointer", "int", "pointer"]);
    Interceptor.replace(albumTitleAddr, new NativeCallback((self: NativePointer, index: number, method: NativePointer) => {
        if (index === VIRTUAL_ALBUM_LIST_INDEX) return pinnedString(ALBUM_TITLE);
        return albumTitleOriginal(self, index, method) as NativePointer;
    }, "pointer", ["pointer", "int", "pointer"]));

    // 커버·음악·미리듣기: 가상 키로 요청되면 원본엔 숙주 에셋 이름을 넘기고, 끝나면 곡 폴더 파일로 만든 것으로 바꾼다.
    const audioLoader = findClass("RuntimeAudioClipLoader.Manager");
    Interceptor.attach(Il2Cpp.module.base.add(0x1FDA3D4), {   // ResourcesManager.LoadFromName<T>(string) 공유 본체
        onEnter(args) {
            const p = args[1];
            if (p.isNull()) return;
            const name = p.add(0x14).readUtf16String(p.add(0x10).readS32());
            if (!name) return;
            const req = assetRequests.get(name);
            if (req) {
                (this as any).asset = name;
                args[1] = pinnedString(req.hostName);
            } else if (name.endsWith("_music")) {
                (this as any).music = name;
            }
        },
        onLeave(ret) {
            if (ret.isNull()) return;
            // 본곡: 배틀 시작 시점엔 m_MusicUid가 가상 곡 uid라 그걸로 고른다.
            if ((this as any).music) {
                const song = currentCustomSong();
                if (!song?.musicPath) return;
                (this as any).asset = `hwa_music_${song.virtualUid}`;
                if (!assetRequests.has((this as any).asset)) assetRequests.set((this as any).asset, { kind: "music", song, hostName: (this as any).music });
            }
            const key: string | undefined = (this as any).asset;
            if (!key) return;
            guard("asset-swap", () => {
                const req = assetRequests.get(key)!;
                // 음악과 미리듣기는 같은 OGG → 한 번만 디코드
                const cacheKey = req.kind === "cover" ? key : `audio:${req.song.virtualUid}`;
                let made = assetCache.get(cacheKey);
                if (!made) {
                    const started = Date.now();
                    const obj = req.kind === "cover"
                        ? spriteFromFile(req.song.coverPath!)
                        : audioLoader?.method<Il2Cpp.Object>("Load", 4).invoke(Il2Cpp.string(req.song.musicPath!), false, false, true) ?? null;
                    if (!obj || obj.isNull()) { log({ t: "asset-fail", key }); return; }
                    obj.ref(true);
                    made = obj;
                    assetCache.set(cacheKey, made);
                    log({ t: "asset-made", key, kind: req.kind, ms: Date.now() - started });
                }
                ret.replace(made.handle);
                if (req.kind === "music") setBattleAudioLength(made.method<number>("get_length").invoke());
            });
        }
    });
    log({ t: "custom-tag-ready" });
}
