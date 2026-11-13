// 커스텀 태그 "실험 모드" + 가상 앨범(1999-0) + 가상 곡(1999-N, 숙주 곡 MusicInfo 얕은 복제) 주입.
// PC 모드 Patches/UI/Custom/Tags/CustomTagRegistry.cs + Support/CustomTagRegistrySupport.cs + CustomTagPatch.cs 이식본.
// 게임 자체의 커스텀 태그 구조(DBConfigCustomTags.CustomTagInfo → AlbumTagInfo.InitCustomTagInfo → DBMusicTag.AddAlbumTagData)를 그대로 쓴다.
// 파일 나눔(2026-11-13): virtual.ts(가상 곡·앨범), icon.ts(태그 아이콘), sprite.ts(커버), 여기(태그 등록·훅).
import { perfMark } from "../perf.js";
import { installCustomAudio } from "../audio/index.js";
import { guard, log } from "../log.js";
import { pinnedString } from "../native.js";
import { gameClass } from "../il2cpp.js";
import { TAG_INDEX, TAG_UID, allSongs } from "../hwa/library.js";
import type { HwaSong } from "../hwa/library.js";
import { currentCustomSong, setBattleAudioLength } from "../customChart.js";
import { getTagIconPath } from "./icon.js";
import { spriteFromFile } from "./sprite.js";
import { ALBUM_TITLE, VIRTUAL_ALBUM_LIST_INDEX, VIRTUAL_LIST_INDEX_BASE, assetCache, assetRequests, hostMusicNames, localByClone, localByListIndex, makeAlbum, makeVirtualSong, virtualClones } from "./virtual.js";

const TAG_NAMES: [string, string][] = [
    ["Korean", "실험 모드"], ["English", "Experiment Mod"], ["Japanese", "実験モード"],
    ["ChineseSimplified", "实验模式"], ["ChineseTraditional", "實驗模式"]
];

const cls = gameClass;
let virtualAlbum: Il2Cpp.Object | null = null;

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
    log({ t: "tag-registered", tagIndex: TAG_INDEX, songs: uids, album: !!album, icon: iconPath });
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
    // 본곡은 StageBattleComponent.PlayMusic / AudioManager.LoadBgm 호출 깊이 또는 hostMusicNames로도 잡아,
    // 숙주의 music 키가 `_music`으로 끝나지 않는 곡에서도 숙주 BGM이 대신 나오는 일을 막는다.
    const audio = installCustomAudio();
    let battleBgmDepth = 0;
    const trackBattleBgm = (addr: NativePointer) => Interceptor.attach(addr, {
        onEnter() { battleBgmDepth++; },
        onLeave() { battleBgmDepth--; }
    });
    trackBattleBgm(cls("FormulaBase.StageBattleComponent").method("PlayMusic").virtualAddress);
    trackBattleBgm(cls("Assets.Scripts.PeroTools.Managers.AudioManager").method("LoadBgm").virtualAddress);

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
            } else if (battleBgmDepth > 0 || name.endsWith("_music") || hostMusicNames.has(name)) {
                const song = currentCustomSong();
                if (song?.musicPath) (this as any).music = { name, song };
            }
        },
        onLeave(ret) {
            const musicReq = (this as any).music as { name: string; song: HwaSong } | undefined;
            if (ret.isNull() && ((this as any).asset || musicReq)) {
                log({ t: "asset-load-null", asset: (this as any).asset ?? null, music: musicReq?.name ?? null });
            }
            // 본곡: 배틀 시작 시점엔 m_MusicUid가 가상 곡 uid라 그걸로 고른다.
            if (musicReq) {
                const key = `hwa_music_${musicReq.song.virtualUid}`;
                (this as any).asset = key;
                if (!assetRequests.has(key)) assetRequests.set(key, { kind: "music", song: musicReq.song, hostName: musicReq.name });
            }
            const key: string | undefined = (this as any).asset;
            if (!key) return;
            guard("asset-swap", () => {
                const req = assetRequests.get(key)!;
                const started = Date.now();
                let made: Il2Cpp.Object | null;
                if (req.kind === "cover") {
                    audio.warmAll(allSongs());
                    made = assetCache.get(key) ?? null;
                    if (!made) {
                        made = spriteFromFile(req.song.coverPath!);
                        if (made) assetCache.set(key, made);
                        log({ t: "asset-made", key, kind: req.kind, ms: Date.now() - started });
                        perfMark(`cover:${Date.now() - started}`);
                    }
                } else if (req.kind === "demo") {
                    made = audio.preview(req.song);
                } else {
                    made = audio.music(req.song);
                }
                if (!made || made.isNull()) { log({ t: "asset-fail", key }); return; }
                ret.replace(made.handle);
                if (req.kind === "music") setBattleAudioLength(made.method<number>("get_length").invoke());
            });
        }
    });
    log({ t: "custom-tag-ready" });
}
