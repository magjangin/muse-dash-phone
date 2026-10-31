// 뮤즈대시 모드 비서 앱(com.hwa.musedash.assistant)이 받은 곡을 앱 전용 폴더(HWA_DIR)로 가져온다.
// Android 11+에서 게임은 공용 /MuseDash/hwa 안의 남이 만든 파일(.bms/.txt/.ogg)을 못 읽고,
// 비서 앱은 게임의 Android/data 에 못 쓴다. 그래서 비서 앱이 읽기 전용 ContentProvider(SongProvider)를 열고
// 게임에만 URI 읽기 권한을 주며, 여기서 Java로 그 목록을 받아 크기가 다른 파일만 복사한다.
// 비서 앱에서 지운 곡은 우리가 가져온 폴더(MARKER 있는 폴더)만 지운다. adb로 직접 넣은 곡은 건드리지 않는다.
import Java from "frida-java-bridge";
import { log } from "../log.js";

const AUTHORITY = "content://com.hwa.musedash.assistant.songs";
const MARKER = ".from_assistant";

interface RemoteFile { path: string; size: number; }

function fileUri(path: string): string {
    return `${AUTHORITY}/file/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function pullFromAssistant(destRoot: string): void {
    if (!Java.available) {
        log({ t: "assistant-sync-skip", reason: "java unavailable" });
        return;
    }
    Java.performNow(() => {
        const app = Java.use("android.app.ActivityThread").currentApplication();
        if (app === null) {
            log({ t: "assistant-sync-skip", reason: "no application" });
            return;
        }
        const resolver = app.getContentResolver();
        const Uri = Java.use("android.net.Uri");
        const JFile = Java.use("java.io.File");
        const FileOutputStream = Java.use("java.io.FileOutputStream");

        // 비서 앱이 없거나 권한을 아직 안 줬으면(재부팅 후 비서 앱을 안 열었을 때) 예외/null → 기존 곡으로 그대로 진행.
        let cursor;
        try {
            cursor = resolver.query(Uri.parse(`${AUTHORITY}/list`), null, null, null, null);
        } catch (e) {
            log({ t: "assistant-sync-skip", reason: `${e}` });
            return;
        }
        if (cursor === null) {
            log({ t: "assistant-sync-skip", reason: "provider not found" });
            return;
        }
        const remote: RemoteFile[] = [];
        try {
            const pathCol = cursor.getColumnIndexOrThrow("path");
            const sizeCol = cursor.getColumnIndexOrThrow("size");
            while (cursor.moveToNext()) {
                remote.push({ path: cursor.getString(pathCol), size: Number(cursor.getLong(sizeCol)) });
            }
        } finally {
            cursor.close();
        }

        const folders = new Set(remote.map(f => f.path.split("/")[0]));
        const buffer = Java.array("byte", new Array(65536).fill(0));
        let copied = 0;
        let failed = 0;
        for (const f of remote) {
            const local = JFile.$new(`${destRoot}/${f.path}`);
            if (local.isFile() && Number(local.length()) === f.size) continue;
            try {
                local.getParentFile().mkdirs();
                const input = resolver.openInputStream(Uri.parse(fileUri(f.path)));
                const output = FileOutputStream.$new(local, false);
                try {
                    for (;;) {
                        const n = input.read(buffer);
                        if (n <= 0) break;
                        output.write(buffer, 0, n);
                    }
                } finally {
                    input.close();
                    output.close();
                }
                copied++;
            } catch (e) {
                failed++;
                log({ t: "assistant-sync-error", path: f.path, error: `${e}` });
            }
        }
        for (const folder of folders) {
            JFile.$new(`${destRoot}/${folder}/${MARKER}`).createNewFile();
        }

        let removed = 0;
        const localDirs = JFile.$new(destRoot).listFiles();
        if (localDirs !== null) {
            for (const dir of localDirs) {
                if (!dir.isDirectory() || folders.has(dir.getName())) continue;
                if (!JFile.$new(dir, MARKER).exists()) continue;
                deleteRecursive(dir);
                removed++;
            }
        }
        log({ t: "assistant-sync", songs: folders.size, files: remote.length, copied, failed, removed });
    });
}

function deleteRecursive(f: Java.Wrapper): void {
    if (f.isDirectory()) {
        const children = f.listFiles();
        if (children !== null) {
            for (const child of children) deleteRecursive(child);
        }
    }
    f.delete();
}
