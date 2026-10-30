# 구조 설명 (Muse Dash Android 6.8.0, arm64-v8a)

PC 모드 [muse-dash-test](https://github.com/magjangin/muse-dash-test)(MelonLoader + Harmony, C#)의 커스텀 차트 파이프라인을 **Frida Gadget + [frida-il2cpp-bridge](https://github.com/vfsfitvnm/frida-il2cpp-bridge)(TypeScript)** 로 옮긴 것입니다. MelonLoader/LemonLoader는 이 빌드에서 뜨지 않아 쓰지 않았습니다.

## 게임 정보

- Unity 2019.4.41f1, **IL2CPP**, metadata v24.4. Java 쪽은 기본 `UnityPlayerActivity`뿐이라 모든 훅은 `libil2cpp.so`에 겁니다.
- 아래 RVA는 6.8.0(versionCode 632) arm64 전용입니다. 앱이 업데이트되면 전부 다시 찾아야 합니다. 대부분은 bridge가 **이름으로** 찾기 때문에(`probe.ts`가 이름 ↔ RVA를 대조해 로그에 남김) 숫자 RVA는 일부 모듈만 씁니다.
- 게임 쪽 핫픽스는 에셋(앨범)만 받고 코드는 바꾸지 않습니다.

## 흐름

```
앱 시작 ─ Gadget(script 모드) → files/mod.js
  └ Il2Cpp.perform
      ├ safety      점수 업로드·클라우드 세이브 차단
      ├ customChart files/hwa/<곡>/ 스캔 → BMS 파싱 → 가상 곡 1999-N
      ├ customTag   MusicTagManager.InitAlbumTagInfo 이후 "실험 모드" 태그·앨범·곡 등록
      ├ battle      보스·씬·타이머·정확도·offset
      ├ ghost / hitpoints / progress
곡 선택  ─ LoadFromName 훅: hwa_cover_1999-N → Sprite, hwa_demo_1999-N → AudioClip
배틀 시작 ─ DBStageInfo.SetRuntimeMusicData → BMS → MusicData 배열 주입
          └ 본곡 AudioClip: 숙주 곡 music 키로 로드될 때 곡 폴더 OGG로 교체
매 프레임 ─ UnityGameManager.LoopUpdate 이탈 → HitPoints 재시도, 진행바, 싱크 샘플
```

## 파일 ↔ PC 원본

| TS 파일 | PC 원본 | 역할 |
|---|---|---|
| `bms/parser.ts` | `Bms/BmsParser.cs` + `.Lexer.cs` + `BmsModels.cs` | BMS → 노트·BPM·시간 |
| `bms/wav.ts` | `Bms/BmsWavParser.cs` | #WAV 파일명 → uid·dt·노트 종류·보스 표식 |
| `hwa/manifest.ts` | `Patches/Hwa/HwaManifestLoader.cs` | info.txt 파서(키 포함 규칙·판정 순서 동일) + `android delay` |
| `hwa/library.ts` | `HwaResourceManager(.Bms).cs`, `Core/CustomContentIds.cs` | 곡 폴더 탐색, 가상 uid 1999-N |
| `chart/spec.ts` | `DBStageInfoExperimentChart.*.cs`, `BmsNoteMatcher.cs`, `BmsDtTable.cs` | 노트 스펙·프리팹·dt·보스 자동 교체 |
| `chart/inject.ts` | `DBStageInfoExperimentChart.cs` + `.Sorting.cs` | MusicData 배열 생성·동시치기·showTick 정렬 |
| `customChart.ts` | `DBStageInfoPatch.cs` | SetRuntimeMusicData 훅, delay |
| `customTag.ts` | `CustomTagRegistry.cs`, `CustomTagPatch.cs` | 태그·가상 앨범·가상 곡·제목·커버·미리듣기 |
| `battle.ts` | `BossPatch.cs`, `GameMusicScene*Patch.cs`, `SceneFlowPatch.cs`, `NoteAnimationSyncPatch.cs`, `APModPatch.Accuracy.cs`, `OffsetHookPatches` | 배틀 보조 |
| `ghost.ts` | 고스트 노트 보이기 | Spine 타임라인 알파 |
| `hitpoints.ts` | `ExperimentHitPointInstaller.cs` | 씬을 바꾼 뒤 빠지는 판정 과녁 고리 복구 |
| `progress.ts` | `ProgressBarPatch.cs`, `HwaSyncManager` | 진행바 = 게임 시계 / 곡 길이 |
| `safety.ts` | (Android 전용) | 서버 업로드 차단 |

## 주요 훅

| 대상 | RVA | 하는 일 |
|---|---|---|
| `MusicTagManager::InitAlbumTagInfo` | 0x1DE4E34 | 이탈 후 커스텀 태그 등록 |
| `MusicTagManager::RefreshStageDisplayMusics` | 0x1DE38C0 | 태그 1999(와 −1)는 건너뜀 (원본이 NRE) |
| `MusicInfo::GetLocal` | 0x1CAC538 | 가상 곡 제목·아티스트 (replace) |
| `DBConfigLocalALBUM::GetLocalAlbumInfoByIndex` | 0x20C2600 | listIndex ≥ 100000 → 가상 곡 정보 (replace) |
| `DBConfigAlbums::GetAlbumInfoByMusicInfo` | 0x1D36274 | 가상 곡 → 가상 앨범 |
| `ResourcesManager::LoadFromName<T>` | 0x1FDA3D4 | 커버 Sprite, 미리듣기·본곡 AudioClip 교체 (모든 참조형 T가 이 본체 공유, x2 = MethodInfo) |
| `DBStageInfo::SetRuntimeMusicData` | 0x20D29D4 | 이탈 후 차트 주입 |
| `DBStageInfo::get_delay` | 0x20D2860 | 반환 Decimal을 `android delay`로 |
| `Boss::InitBossObject` / `Boss::Play` | — (이름) | 시작 보스 교체, `swap:<보스>:<씬>` |
| `GameMusicScene::LoadScene` | — (이름) | info.txt 씬으로 |
| `StageBattleComponent::IsIgnoreCurrentNoteChecking`, `GameMusicScene::IsIgnoreCurrentNoteChecking` | 0x1D65334 / 0x1D521A0 | 커스텀 곡이면 true |
| `GameMusicScene::InitTimer(Decimal)` | — (이름) | 곡 길이 + 30초 |
| `StageBattleComponent::FixedOffset` / `FixedMusicOffset` | — / 0x1D60668 | 이탈 후 `<offset>k__BackingField`(+0xA8) = info.txt offset |
| `TaskStageTarget::GetTrueAccuracy(New)` | 0x205BBC4 / 0x205B79C | 커스텀 곡 정확도 공식 (replace) |
| `StageBattleComponent::GetTimeProgress`, `PnlBattle::<MusicProgressInit>b__48_1` | 0x1D5F4A8 / — | 진행률 (replace) |
| `UnityGameManager::LoopUpdate` | 0x1E62D24 | 프레임 콜백 |
| `StatisticsManager::UploadScore` / `GameAccountSystem::Synchronize` | 0x1ED32E8 / 0x22F5D78 | 빈 함수로 (replace) |

## 데이터 레이아웃 (이 빌드)

- `MusicData`, `NoteConfigData`, `MusicConfigData`, `MusicExInfo`는 **struct**입니다(PC 6.7.0의 박싱 함정 없음). `List<MusicData>._items`는 0x160바이트 원소 배열이라, 새 배열을 만들어 `_items`(0x10)/`_size`(0x18)/`_version`(0x1C)을 바꿉니다. 배열 데이터는 +0x20부터.
- MusicData: objId 0, tick 4, configData 0x18, noteData 0x50, isLongPressing 0x110, doubleIdx 0x114, isDouble 0x120, isLongPressEnd 0x121, longPressPTick 0x124, endIndex 0x134, dt 0x138, longPressNum 0x148, showTick 0x14C.
- `System.Decimal` = {flags(scale<<16, 부호 bit31), hi, lo, mid}. 반환은 x0:x1, 값 인자는 GPR 두 개.
- MusicInfo: uid 0x20, name 0x28, author 0x30, music 0x40, demo 0x48, cover 0x50, noteJson 0x60, unlockLevel 0xDC, m_AlbumIndex 0xE8, m_AlbumUidIndex 0xEC, m_AlbumUidName 0xF8, listIndex 0x10.

## 가상 곡을 만드는 방식

- 숙주 곡(info.txt의 uid) `MusicInfo`를 `MemberwiseClone`한 뒤 uid `1999-N`, 이름·작곡가·레벨 디자이너·난이도를 바꿉니다.
- **앨범 json 번호(m_AlbumIndex)는 숙주 것을 그대로 둡니다.** PC처럼 2000을 넣으면 `ALBUM2000` 로드 예외로 프로세스가 죽습니다.
- **음악 키(music)도 숙주 것을 둡니다.** 가상 키를 넣으면 게임이 번들 다운로드를 시도해 "데이터 다운로드를 실패했어요"가 뜹니다. 배틀에서 숙주 키로 로드될 때 현재 곡이 커스텀이면 곡 폴더 OGG로 바꿉니다.
- 커버·미리듣기 키만 `hwa_cover_1999-N` / `hwa_demo_1999-N`으로 바꾸고 `LoadFromName`에서 만들어 줍니다. 제목은 listIndex를 100000+N으로 주고 `GetLocalAlbumInfoByIndex`를 바꿔 해결했습니다.
- 태그 아이콘은 `file://` 경로여야 합니다(앞에 안 붙이면 http URL로 읽힘).

## BGM 싱크

게임 공식: 음악 시작 = GameStart 후 (−delay + offset)초, 음악 위치 = 경과 + delay − offset (`get_getMusicOffset`).

PC 모드 info.txt의 `delay`(예 −0.575)는 PC 스트리밍 BGM 경로에 맞춘 값이라, Android에 그대로 쓰면 음악이 0.57초 늦습니다(실측). 그래서 Android는 `delay`를 읽지 않고 기본 0, 필요하면 `android delay`로만 조정합니다. offset은 PC와 같은 순서(FixedOffset·FixedMusicOffset **이탈 후**)로 씁니다. 실측 음악 − 게임 시계: **+0.008초**.

## 훅을 걸 때 지킨 원칙

- 원본이 관리 예외를 던질 수 있으면 `Interceptor.attach` 대신 원본을 부르지 않는 `Interceptor.replace`를 씁니다. 관리 예외가 Frida attach 프레임을 지나가면 `Il2CppExceptionWrapper`로 abort됩니다.
- 관리 코드 호출은 bridge `invoke`로 합니다(예외를 JS 오류로 바꿔 줌). 각 기능은 `guard()`로 감싸 하나가 실패해도 나머지는 돕니다. 프레임 콜백도 실패하면 그 기능만 끕니다.
- 모듈 로드 감시는 `attachModuleObserver` 대신 bridge의 `Il2Cpp.perform` 대기를 씁니다(옵저버는 링커 SIGABRT).
- script 모드엔 console 출력이 logcat에 안 나와 `files/mod.log`에 JSON 한 줄씩 씁니다.

## 해 보고 안 된 것

| 시도 | 결과 → 대신 한 것 |
|---|---|
| MelonLoader/LemonLoader 이식 | 이 빌드에서 안 뜸 → Frida Gadget |
| Gadget listen 모드 + PC 세션 | 세션 끊기면 훅 소멸 → script 모드 |
| 가상 앨범 json 번호 2000 | `ALBUM2000` 예외로 abort → 숙주 번호 유지 + GetLocal 교체 |
| 가상 music 키 | 번들 다운로드 실패 팝업 → 숙주 키 유지, 배틀 시 교체 |
| `GameMusicScene.Run`을 프레임 훅으로 | GameStart에서 한 번만 불림 → `UnityGameManager.LoopUpdate` |
| offset을 seek 전에 쓰기 | 원본이 덮어씀 → PC와 같은 이탈 후 |
| PC delay를 그대로 | 음악 0.57초 늦음 → `android delay`(기본 0) |
| `AudioSettings.get_outputSampleRate` | 스트리핑돼 없음 → 48 kHz 가정(로그용) |
