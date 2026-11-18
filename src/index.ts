import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { AccessHandler } from "./access-handler";

type Env = {
        OAUTH_KV: KVNamespace;
        ACCESS_CLIENT_ID: string;
        ACCESS_CLIENT_SECRET: string;
        ACCESS_TOKEN_URL: string;
        ACCESS_AUTHORIZATION_URL: string;
        ALLOWED_EMAIL?: string;
        // Honoラッパー(VPS上のvault-files)経由でObsidian Vaultを読み書きするための設定
        WRAPPER_BASE_URL: string; // 例: "https://vault-api.sigeur.com"
        WRAPPER_AUTH_TOKEN: string;
        // Nextcloud CalDAV連携用
        NEXTCLOUD_USERNAME: string;
        NEXTCLOUD_APP_PASSWORD: string;
        // Nextcloud WebDAV連携用
        NEXTCLOUD_WEBDAV_PASSWORD: string;
};

//note read/write start (旧: GitHub Contents/Trees API → Honoラッパー(VPS)経由に切替)

/**
 * ツール呼び出し側は従来通り "sige/" プレフィックス付きパスを渡す想定(後方互換)。
 * Honoラッパー(vault-files直下、"sige/"なし)向けの実パスに変換する。
 */
function toWrapperPath(repoPath: string): string {
        return repoPath.startsWith("sige/") ? repoPath.slice("sige/".length) : repoPath;
}

/** wrapper→呼び出し側の表記に戻す("sige/"を付け直す) */
function fromWrapperPath(vaultPath: string): string {
        return `sige/${vaultPath}`;
}

async function wrapperFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
        return fetch(`${env.WRAPPER_BASE_URL}${path}`, {
                ...init,
                headers: {
                        ...(init?.headers ?? {}),
                        Authorization: `Bearer ${env.WRAPPER_AUTH_TOKEN}`,
                },
        });
}

/** 指定パスのノート本文を1本取得する */
async function fetchNoteFromWrapper(env: Env, repoPath: string): Promise<string> {
        const p = toWrapperPath(repoPath);
        const res = await wrapperFetch(env, `/file?path=${encodeURIComponent(p)}`);
        if (res.status === 404) throw new Error(`ノートが見つからへんかった: ${repoPath}`);
        if (!res.ok) throw new Error(`ラッパーAPIエラー (${res.status}): ${await res.text()}`);
        return res.text();
}

/** ノートが存在するかだけ確認する(create/append/update/deleteの事前チェック用) */
async function noteExistsOnWrapper(env: Env, repoPath: string): Promise<boolean> {
        const p = toWrapperPath(repoPath);
        const res = await wrapperFetch(env, `/file?path=${encodeURIComponent(p)}`);
        if (res.status === 404) return false;
        if (!res.ok) throw new Error(`ラッパーAPIエラー (${res.status}): ${await res.text()}`);
        return true;
}

/** ノートを作成/上書きする */
async function putNoteToWrapper(
        env: Env,
        repoPath: string,
        content: string,
        tool: "create_note" | "append_to_note" | "update_note", // 監査ログ互換のため旧ツール名のまま(write_note の mode に対応)
): Promise<void> {
        const p = toWrapperPath(repoPath);
        const res = await wrapperFetch(env, `/file?path=${encodeURIComponent(p)}`, {
                method: "PUT",
                headers: { "X-MCP-Tool": tool }, // 監査ログ(R2)用: どのツール経由の書き込みか
                body: content,
        });
        if (!res.ok) throw new Error(`書き込みに失敗 (${res.status}): ${await res.text()}`);
}

/** ノートを削除する */
/** R3: wrapper は削除をゴミ箱への移動にした。移動先(trashPath)と保持日数を返す(ゴミ箱内の完全削除では無い) */
interface DeleteResult {
        status?: string;
        trashPath?: string;
        keepDays?: number;
}

async function deleteNoteFromWrapper(env: Env, repoPath: string): Promise<DeleteResult> {
        const p = toWrapperPath(repoPath);
        const res = await wrapperFetch(env, `/file?path=${encodeURIComponent(p)}`, {
                method: "DELETE",
                headers: { "X-MCP-Tool": "delete_note" },
        });
        if (!res.ok) throw new Error(`削除に失敗 (${res.status}): ${await res.text()}`);
        return ((await res.json().catch(() => ({}))) as DeleteResult) ?? {};
}

/**
 * read_note 用: 全文、または head/tail の抜粋を返す(GET /file?head=N / tail=N)。
 * 切り詰めたときだけ末尾に「全N行中…」の1行を足す。head/tail なしは従来どおり本文のみ。
 */
async function readNoteForTool(env: Env, repoPath: string, head?: number, tail?: number): Promise<string> {
        if (head === undefined && tail === undefined) return fetchNoteFromWrapper(env, repoPath);
        if (head !== undefined && tail !== undefined) throw new Error("head と tail は同時に指定できない");
        const p = toWrapperPath(repoPath);
        const qs = head !== undefined ? `head=${head}` : `tail=${tail}`;
        const res = await wrapperFetch(env, `/file?path=${encodeURIComponent(p)}&${qs}`);
        if (res.status === 404) throw new Error(`ノートが見つからへんかった: ${repoPath}`);
        if (!res.ok) throw new Error(`ラッパーAPIエラー (${res.status}): ${await res.text()}`);
        const text = await res.text();
        if (res.headers.get("X-Truncated") !== "1") return text;
        const total = res.headers.get("X-Total-Lines");
        const returned = res.headers.get("X-Returned-Lines");
        const where = head !== undefined ? "先頭" : "末尾";
        return `${text}\n[全${total}行中、${where}${returned}行を表示]`;
}

/**note_move helper start*/
/** 移動結果1件分(POST /move の results 要素) */
type MoveResult = {
        from: string;
        to: string;
        status: "planned" | "moved" | "skipped" | "error";
        reason?: string;
};

/**
 * 複数ノートを移動する(POST /move)。dryRun=trueのときは計画だけ返して何も動かさない。
 * 移動はVPS内のfs操作で完結する(本文はここを通らない)。上書きはせず、移動先に同名があればskipped。
 */
async function moveNotesOnWrapper(
        env: Env,
        moves: { from: string; to: string }[],
        dryRun: boolean,
): Promise<MoveResult[]> {
        const res = await wrapperFetch(env, `/move`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-MCP-Tool": "move_notes" },
                body: JSON.stringify({
                        moves: moves.map((m) => ({ from: toWrapperPath(m.from), to: toWrapperPath(m.to) })),
                        dryRun,
                }),
        });
        if (!res.ok) throw new Error(`移動に失敗 (${res.status}): ${await res.text()}`);
        const data = (await res.json()) as { dryRun: boolean; results: MoveResult[] };
        return data.results.map((r) => ({
                ...r,
                from: fromWrapperPath(r.from),
                to: fromWrapperPath(r.to),
        }));
}

/** edit note helper */
/** 部分編集1件分の結果(POST /edit の edits 要素) */
type EditItemResult = {
        status: "ok" | "error";
        matches?: number;
        lines?: number[];
        reason?: string;
};

/** POST /edit のレスポンス */
type EditNoteResult = {
        path: string;
        dryRun: boolean;
        ok: boolean;
        applied: boolean;
        edits: EditItemResult[];
        bytesBefore: number;
        bytesAfter?: number;
};

/** wrapperのエラー応答({error: "..."})からメッセージを取り出す */
async function readWrapperError(res: Response): Promise<string> {
        const text = await res.text();
        try {
                const parsed = JSON.parse(text) as { error?: string };
                return parsed.error ?? text;
        } catch {
                return text;
        }
}

/**
 * ノートを部分編集する(POST /edit、str_replace方式)。
 * old_strがちょうど1か所に見つかるときだけ置換する。複数editは全部有効なときだけ一括適用(1つでもNGなら何も変更しない)。
 * 書き込みはVPS側で原子的に行い、同じノートへの同時編集は順番に処理される。
 */
async function editNoteOnWrapper(
        env: Env,
        repoPath: string,
        edits: { old_str: string; new_str: string; replace_all?: boolean }[],
        dryRun: boolean,
): Promise<EditNoteResult> {
        const res = await wrapperFetch(env, `/edit`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-MCP-Tool": "edit_note" },
                body: JSON.stringify({
                        path: toWrapperPath(repoPath),
                        edits: edits.map((e) => ({
                                oldStr: e.old_str,
                                newStr: e.new_str,
                                replaceAll: e.replace_all === true,
                        })),
                        dryRun,
                }),
        });
        if (res.status === 404) throw new Error(`${repoPath} が見つからへん。パス間違いかも。`);
        if (!res.ok) throw new Error(`編集に失敗 (${res.status}): ${await readWrapperError(res)}`);
        const data = (await res.json()) as EditNoteResult;
        return { ...data, path: fromWrapperPath(data.path) };
}

/** Vault内の.mdファイルパス一覧を取得する(search_notes用) */
async function listVaultMarkdownPaths(env: Env, prefix = ""): Promise<string[]> {
        const p = toWrapperPath(prefix);
        const res = await wrapperFetch(env, `/list?prefix=${encodeURIComponent(p)}`);
        if (!res.ok) throw new Error(`ファイル一覧の取得に失敗 (${res.status}): ${await res.text()}`);
        const data = (await res.json()) as { files: string[] };
        return data.files.filter((f) => f.endsWith(".md")).map(fromWrapperPath);
}

/** 指定prefix配下のノートを一括取得する(GET /bulk-read) */
async function readFolderBulkFromWrapper(
        env: Env,
        prefix: string,
): Promise<{ path: string; content: string }[]> {
        const p = toWrapperPath(prefix);
        const res = await wrapperFetch(env, `/bulk-read?prefix=${encodeURIComponent(p)}`);
        if (!res.ok) throw new Error(`一括取得に失敗 (${res.status}): ${await res.text()}`);
        const data = (await res.json()) as { files: { path: string; content: string }[] };
        return data.files
                .filter((f) => f.path.endsWith(".md"))
                .map((f) => ({ path: fromWrapperPath(f.path), content: f.content }));
}

/** 追加 */
type LsEntry = { path: string; type: "d" | "f"; size?: number; mtime?: string };

/** Honoラッパーの /ls を叩く。prefixは "sige/..." でも "sige" でも可。返却パスには "sige/" を付け直す */
async function listFolderOnWrapper(
        env: Env,
        prefix: string,
        depth: number,
        details: boolean,
        limit: number,
): Promise<{ count: number; truncated: boolean; entries: LsEntry[] }> {
        const trimmed = prefix.replace(/\/+$/, "");
        const p = trimmed === "sige" ? "" : toWrapperPath(trimmed);
        const res = await wrapperFetch(
                env,
                `/ls?prefix=${encodeURIComponent(p)}&depth=${depth}&details=${details}&limit=${limit}`,
        );
        if (!res.ok) throw new Error(await readWrapperError(res));
        const data = (await res.json()) as { count: number; truncated: boolean; entries: LsEntry[] };
        return {
                count: data.count,
                truncated: data.truncated,
                entries: data.entries.map((e) => ({ ...e, path: fromWrapperPath(e.path) })),
        };
}
/** 追加end */

/** 本文全文検索(サーバーサイド、VPS上のfsを直接検索するので高速・Vaultサイズ非依存) */
async function searchNoteContentOnWrapper(
        env: Env,
        query: string,
        prefix: string,
): Promise<{ path: string; snippet: string }[]> {
        const p = toWrapperPath(prefix);
        const url = `/search?q=${encodeURIComponent(query)}&prefix=${encodeURIComponent(p)}`;
        const res = await wrapperFetch(env, url);
        if (!res.ok) throw new Error(`検索に失敗 (${res.status}): ${await res.text()}`);
        const data = (await res.json()) as { hits: { path: string; snippet: string }[] };
        return data.hits.map((h) => ({ path: fromWrapperPath(h.path), snippet: h.snippet }));
}

//note read/write end

//start url settings
const CALDAV_BASE = "https://fie.nl.tab.digital/remote.php/dav/calendars";
const WEBDAV_BASE = "https://fie.nl.tab.digital/remote.php/dav/files/sige";
//end url settings


//calendar helpers start
function calendarUrl(env: Env): string {
        return `${CALDAV_BASE}/${env.NEXTCLOUD_USERNAME}/personal/`;
}

function authHeader(env: Env): string {
        const raw = `${env.NEXTCLOUD_USERNAME}:${env.NEXTCLOUD_APP_PASSWORD}`;
        return "Basic " + btoa(raw);
}

// タスクリスト(カレンダーコレクション)のベースURL。この直下に各リストのコレクションが並ぶ。
function calendarsBaseUrl(env: Env): string {
        return `${CALDAV_BASE}/${env.NEXTCLOUD_USERNAME}/`;
}

// 個別タスクリストのURL。idはlist_tasks(lists)で取得したhref末尾の部分。
function taskCalendarUrl(env: Env, listId: string): string {
        return `${CALDAV_BASE}/${env.NEXTCLOUD_USERNAME}/${listId}/`;
}

function escapeXml(s: string): string {
        return s
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&apos;");
}

/**
 * タスク/予定用のカレンダーコレクション一覧を取得する共通関数。
 * personal(予定)とcontact_birthdays、inbox/outbox/trashbin等の特殊コレクションは除外する。
 * list_tasks から使う(lists の返却とlistId省略時の全リスト取得)。
 */
async function getTaskLists(env: Env): Promise<{ id: string; displayname: string }[]> {
        const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
  </d:prop>
</d:propfind>`;

        const res = await fetch(calendarsBaseUrl(env), {
                method: "PROPFIND",
                headers: {
                        Authorization: authHeader(env),
                        "Content-Type": "application/xml; charset=utf-8",
                        Depth: "1",
                },
                body,
        });
        if (!res.ok) {
                throw new Error(`カレンダー一覧取得に失敗: ${res.status} ${await res.text()}`);
        }
        const xml = await res.text();

        const responses = [...xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)];
        return responses
                .map((r) => r[1])
                .filter((r) => /calendar\s*\/?>/i.test(r) && !/schedule-(inbox|outbox)/.test(r))
                .map((r) => {
                        const hrefMatch = r.match(/<d:href>([^<]*)<\/d:href>/);
                        const nameMatch = r.match(/<d:displayname>([^<]*)<\/d:displayname>/);
                        const href = hrefMatch ? hrefMatch[1] : "";
                        // /remote.php/dav/calendars/sige/E33C7990-.../ → E33C7990-... だけ取り出す
                        const idMatch = href.match(/calendars\/[^/]+\/([^/]+)\/?$/);
                        return {
                                id: idMatch ? idMatch[1] : href,
                                displayname: nameMatch ? decodeXmlEntities(nameMatch[1]) : "(no name)",
                        };
                })
                .filter((c) => c.id && c.id !== "personal" && c.id !== "contact_birthdays");
}

const PRIORITY_MAP: Record<string, number> = {
        high: 1,
        medium: 5,
        low: 9,
};
function priorityLabel(n?: number): string | undefined {
        if (n === undefined || n === 0 || Number.isNaN(n)) return undefined;
        if (n <= 4) return "high";
        if (n <= 6) return "medium";
        return "low";
}

function buildVTODO(params: {
        uid: string;
        summary: string;
        due?: string;
        priority?: "high" | "medium" | "low" | "none";
        description?: string;
        status?: "needs_action" | "in_process" | "completed";
}): string {
        const now = nowICS();
        const statusMap: Record<string, string> = {
                needs_action: "NEEDS-ACTION",
                in_process: "IN-PROCESS",
                completed: "COMPLETED",
        };
        const status = statusMap[params.status ?? "needs_action"];
        const isCompleted = params.status === "completed";

        return [
                "BEGIN:VCALENDAR",
                "VERSION:2.0",
                "PRODID:-//shigepi-mcp//caldav-tool//JP",
                "BEGIN:VTODO",
                `UID:${params.uid}`,
                `DTSTAMP:${now}`,
                `SUMMARY:${escapeICSText(params.summary)}`,
                params.due ? `DUE:${toICSDate(params.due)}` : "",
                params.priority && params.priority !== "none"
                        ? `PRIORITY:${PRIORITY_MAP[params.priority]}`
                        : "",
                `STATUS:${status}`,
                isCompleted ? `COMPLETED:${now}` : "",
                isCompleted ? "PERCENT-COMPLETE:100" : "",
                params.description ? `DESCRIPTION:${escapeICSText(params.description)}` : "",
                "END:VTODO",
                "END:VCALENDAR",
        ]
                .filter(Boolean)
                .join("\r\n");
}

/**
 * VTODO/VEVENT本体のプロパティを読む関数を返す。
 * 折り返し行の連結、VTIMEZONE/VALARM等の同名プロパティの除外、行頭一致を行う。
 * text=trueのときはTEXT値としてエスケープ(\n, \, 等)を戻す。
 */
function icsPropGetter(ics: string, comp: "VTODO" | "VEVENT") {
        const unfolded = ics.replace(/\r?\n[ \t]/g, "");
        const m = unfolded.match(new RegExp(`BEGIN:${comp}([\\s\\S]*?)END:${comp}`));
        const body = (m ? m[1] : unfolded).replace(/BEGIN:(\w+)[\s\S]*?END:\1/g, "");
        return (key: string, text = false) => {
                const r = body.match(new RegExp(`^${key}(?:;[^:\\r\\n]*)?:(.*)$`, "m"));
                if (!r) return undefined;
                const v = r[1].trim();
                return text ? unescapeICSText(v) : v;
        };
}

function parseVTODO(ics: string) {
        const get = icsPropGetter(ics, "VTODO");
        const priorityRaw = get("PRIORITY");
        return {
                uid: get("UID"),
                summary: get("SUMMARY", true),
                due: get("DUE"),
                priority: priorityLabel(priorityRaw ? Number(priorityRaw) : undefined),
                status: get("STATUS"),
                description: get("DESCRIPTION", true),
        };
}

/** CalDAVのXMLレスポンスから抜いた文字列の実体参照(&amp;等)を戻す */
function decodeXmlEntities(s: string): string {
        const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
                if (e[0] !== "#") return named[e];
                const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isNaN(code) ? m : String.fromCodePoint(code);
        });
}

/** ICSのTEXT値のエスケープを戻す(\n→改行、\,→, など) */
function unescapeICSText(s: string): string {
        return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** ICSのTEXT値をエスケープする(RFC5545 3.3.11) */
function escapeICSText(s: string): string {
        return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/**
 * 既存VTODOのうち、指定された項目だけを書き換える(save_taskの更新用)。
 * undefinedの項目は触らず、空文字はプロパティ削除。
 * VALARM等の入れ子コンポーネント内の同名プロパティ(DESCRIPTION等)には触れない。
 */
function patchVTODO(
        ics: string,
        p: {
                summary?: string;
                due?: string;
                priority?: "high" | "medium" | "low" | "none";
                description?: string;
                status?: "needs_action" | "in_process" | "completed";
        },
): string {
        // 折り返し行(先頭が空白/タブ)を連結してから行単位で扱う
        const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
        const start = lines.findIndex((l) => l === "BEGIN:VTODO");
        if (start < 0) throw new Error("既存データにVTODOが見つからへん。");

        const set = new Map<string, string | null>(); // null = 削除
        const now = nowICS();
        if (p.summary !== undefined) set.set("SUMMARY", p.summary ? `SUMMARY:${escapeICSText(p.summary)}` : null);
        if (p.due !== undefined) set.set("DUE", p.due ? `DUE:${toICSDate(p.due)}` : null);
        if (p.priority !== undefined)
                set.set("PRIORITY", p.priority === "none" ? null : `PRIORITY:${PRIORITY_MAP[p.priority]}`);
        if (p.description !== undefined)
                set.set("DESCRIPTION", p.description ? `DESCRIPTION:${escapeICSText(p.description)}` : null);
        if (p.status !== undefined) {
                const done = p.status === "completed";
                set.set("STATUS", `STATUS:${{ needs_action: "NEEDS-ACTION", in_process: "IN-PROCESS", completed: "COMPLETED" }[p.status]}`);
                set.set("COMPLETED", done ? `COMPLETED:${now}` : null);
                set.set("PERCENT-COMPLETE", done ? "PERCENT-COMPLETE:100" : null);
        }
        set.set("DTSTAMP", `DTSTAMP:${now}`);
        set.set("LAST-MODIFIED", `LAST-MODIFIED:${now}`);

        const out: string[] = [];
        let depth = 0; // VTODO直下=0、VALARM等の中=1以上
        let end = -1;
        let insertAt = -1; // 追加プロパティの挿入位置(最初の入れ子コンポーネントの前、なければEND:VTODOの前)
        for (let i = 0; i < lines.length; i++) {
                const l = lines[i];
                if (i <= start || end >= 0) {
                        out.push(l);
                        continue;
                }
                if (depth === 0 && l === "END:VTODO") {
                        end = out.length;
                        out.push(l);
                        continue;
                }
                if (l.startsWith("BEGIN:")) {
                        if (depth === 0 && insertAt < 0) insertAt = out.length;
                        depth++;
                }
                else if (l.startsWith("END:")) depth--;
                const key = l.match(/^([A-Z-]+)[;:]/)?.[1];
                if (depth === 0 && key && set.has(key)) continue; // 置き換え対象は一旦外す
                out.push(l);
        }
        if (end < 0) throw new Error("既存データのVTODOが壊れている(END:VTODOなし)。");
        const add = [...set.values()].filter((v): v is string => v !== null);
        out.splice(insertAt >= 0 ? insertAt : end, 0, ...add);
        return out.join("\r\n");
}

/** 現在時刻のUTC表記(toICSDateは入力をJSTとみなすので現在時刻には使えない) */
function nowICS(): string {
        return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function toICSDate(dateStr: string): string {
        // 入力は日本時間(JST, UTC+9)のローカル時刻として扱う。
        // 例: "2026-08-14T11:00:00" (JST 11:00) → UTC 02:00 → "20260814T020000Z"
        //
        // dateStrの末尾に "Z" や "+09:00" 等のタイムゾーン情報が付いていると
        // new Date()がそちらを優先してしまうため、常に "タイムゾーン情報なしの
        // ローカル日時文字列" として渡ってくる前提で、明示的にJST→UTC変換する。
        const m = dateStr.match(
                /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
        );
        if (!m) {
                throw new Error(`日時の形式が不正: ${dateStr} (例: 2026-08-14T11:00:00 の形式で指定してください)`);
        }
        const [, year, month, day, hour, minute, second] = m;

        // JSTのローカル時刻としてUTCミリ秒に変換 (Date.UTCで組み立ててから9時間引く)
        const utcMs =
                Date.UTC(
                        Number(year),
                        Number(month) - 1,
                        Number(day),
                        Number(hour),
                        Number(minute),
                        Number(second),
                ) -
                9 * 60 * 60 * 1000;

        const d = new Date(utcMs);
        const pad = (n: number) => String(n).padStart(2, "0");
        return (
                d.getUTCFullYear().toString() +
                pad(d.getUTCMonth() + 1) +
                pad(d.getUTCDate()) +
                "T" +
                pad(d.getUTCHours()) +
                pad(d.getUTCMinutes()) +
                pad(d.getUTCSeconds()) +
                "Z"
        );
}

function buildICS(params: {
        uid: string;
        summary: string;
        start: string;
        end: string;
        description?: string;
}): string {
        const now = nowICS();
        return [
                "BEGIN:VCALENDAR",
                "VERSION:2.0",
                "PRODID:-//shigepi-mcp//caldav-tool//JP",
                "BEGIN:VEVENT",
                `UID:${params.uid}`,
                `DTSTAMP:${now}`,
                `DTSTART:${toICSDate(params.start)}`,
                `DTEND:${toICSDate(params.end)}`,
                `SUMMARY:${escapeICSText(params.summary)}`,
                params.description ? `DESCRIPTION:${escapeICSText(params.description)}` : "",
                "END:VEVENT",
                "END:VCALENDAR",
        ]
                .filter(Boolean)
                .join("\r\n");
}

// 超簡易ICSパーサー（一覧表示に必要な項目だけ抜く）
function parseICS(ics: string) {
        // VTIMEZONE内にも DTSTART 等の同名プロパティが出てくるため、VEVENT本体だけを見る
        const get = icsPropGetter(ics, "VEVENT");
        return {
                uid: get("UID"),
                summary: get("SUMMARY", true),
                start: get("DTSTART"),
                end: get("DTEND"),
                description: get("DESCRIPTION", true),
        };
}
//calendar helpers end

//read file helpers start
async function readFile(path: string, env: Env) {
  const url = `${WEBDAV_BASE}/${path}`;
  const auth = btoa(`sige:${env.NEXTCLOUD_WEBDAV_PASSWORD}`);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Basic ${auth}`
    }
  });

  if (!res.ok) {
    throw new Error(`ファイル取得に失敗 (${res.status}): ${path}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const isText = contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("markdown") ||
    contentType.includes("xml");

  if (isText) {
    const text = await res.text();
    return { type: "text", content: text, contentType };
  } else {
    const buffer = await res.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return { type: "binary", content: base64, contentType, size: buffer.byteLength };
  }
}
//read file helpers end

//upload file helpers start
async function uploadFile(path: string, content: string, env: Env) {
  const url = `${WEBDAV_BASE}/${path}`;
  const auth = btoa(`sige:${env.NEXTCLOUD_WEBDAV_PASSWORD}`);

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "text/plain; charset=utf-8"
    },
    body: content
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`アップロードに失敗 (${res.status}): ${text}`);
  }

  return { success: true, path };
}
//upload file helpers end

//delete file helpers start
async function deleteFile(path: string, env: Env) {
  const url = `${WEBDAV_BASE}/${path}`;
  const auth = btoa(`sige:${env.NEXTCLOUD_WEBDAV_PASSWORD}`);

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      "Authorization": `Basic ${auth}`
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`削除に失敗 (${res.status}): ${text}`);
  }

  return { success: true, path };
}
//delete file helpers end

//MKKOL helpers start
async function createFolder(path: string, env: Env) {
  const url = `${WEBDAV_BASE}/${path}`;
  const auth = btoa(`sige:${env.NEXTCLOUD_WEBDAV_PASSWORD}`);

  const res = await fetch(url, {
    method: "MKCOL",
    headers: {
      "Authorization": `Basic ${auth}`
    }
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 405) {
      throw new Error(`フォルダ作成に失敗 (405): 既に存在するフォルダか、パスが不正。詳細: ${text}`);
    }
    if (res.status === 409) {
      throw new Error(`フォルダ作成に失敗 (409): 親フォルダが存在しない。先に親フォルダを作成して。詳細: ${text}`);
    }
    throw new Error(`フォルダ作成に失敗 (${res.status}): ${text}`);
  }

  return { success: true, path };
}
//MKKOL helpers start


//start list file helper
async function listFiles(path: string, env: Env) {
  const url = `${WEBDAV_BASE}/${path}`;
  const auth = btoa(`sige:${env.NEXTCLOUD_WEBDAV_PASSWORD}`);

  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Depth": "1",
      "Content-Type": "application/xml"
    },
    body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>`
  });

  if (!res.ok) {
    throw new Error(`WebDAV error: ${res.status}`);
  }

  const xml = await res.text();
  return parseWebDavResponse(xml);
}

function parseWebDavResponse(xml: string) {
  const items = [];
  const responseBlocks = xml.match(/<d:response>[\s\S]*?<\/d:response>/g) || [];

  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<d:href>(.*?)<\/d:href>/);
    if (!hrefMatch) continue;

    const href = decodeURIComponent(hrefMatch[1]);
    const isFolder = /<d:resourcetype>\s*<d:collection\s*\/>\s*<\/d:resourcetype>/.test(block);
    const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/);
    const modMatch = block.match(/<d:getlastmodified>(.*?)<\/d:getlastmodified>/);
    const typeMatch = block.match(/<d:getcontenttype>(.*?)<\/d:getcontenttype>/);

    items.push({
      path: href.replace("/remote.php/dav/files/sige/", ""),
      isFolder,
      size: sizeMatch ? parseInt(sizeMatch[1]) : null,
      lastModified: modMatch ? modMatch[1] : null,
      contentType: typeMatch ? typeMatch[1] : null
    });
  }

  return items.filter(item => item.path !== "");
}
//list files helpers end

function createServer(env: Env) {
        const server = new McpServer({
                name: "Obsidian Vault MCP",
                version: "1.0.0",
        });

        server.registerTool(
                "read_note",
                {
                        description:
                                "Obsidian Vault内の指定パスのノート(Markdownファイル)を1本読み込む。pathはリポジトリルートからの相対パス(例: 'sige/40_Synapse/デイリーノート/2026-08-12.md')。長いノートは head(先頭N行)か tail(末尾N行)で一部だけ読める(同時指定は不可)。切り詰めたときは末尾に全行数が付く。",
                        inputSchema: z.object({
                                path: z.string().describe("リポジトリルートからの相対パス"),
                                head: z.number().int().min(1).max(100000).optional().describe("先頭N行だけ読む。tailとは同時指定不可"),
                                tail: z.number().int().min(1).max(100000).optional().describe("末尾N行だけ読む。headとは同時指定不可"),
                        }),
                },
                async ({ path, head, tail }) => {
                        try {
                                const content = await readNoteForTool(env, path, head, tail);
                                return {
                                        content: [{ type: "text", text: content }],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                {
                                                type: "text",
                                                text: `エラー: ${err instanceof Error ? err.message : String(err)}`,
                                                },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        server.registerTool(
                "read_folder_bulk",
                {
                        description:
                                "Obsidian Vault内の指定フォルダ配下にある全ノート(.md)の中身を一括取得する。フォルダ内の複数ノートをまとめて読みたい時、search_notesで一覧を取ってから1件ずつread_noteするより高速。prefixはリポジトリルートからの相対パス(例: 'sige/10_Project/oracle migrate')。",
                        inputSchema: z.object({
                                prefix: z.string().describe("取得したいフォルダのパス(相対パス)"),
                                limit: z
                                        .number()
                                        .optional()
                                        .describe("最大何件返すか(デフォルト50、多すぎるフォルダ対策)"),
                        }),
                },
                async ({ prefix, limit }) => {
                        try {
                                const files = await readFolderBulkFromWrapper(env, prefix);
                                const capped = files.slice(0, limit ?? 50);
                                return {
                                        content: [
                                                {
                                                type: "text",
                                                text: JSON.stringify(
                                                {
                                                matched_count: files.length,
                                                returned_count: capped.length,
                                                files: capped,
                                                },
                                                null,
                                                2,
                                                ),
                                                },
                                        ],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                {
                                                type: "text",
                                                text: `エラー: ${err instanceof Error ? err.message : String(err)}`,
                                                },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

//* 追加 */
        server.registerTool(
                "list_folder",
                {
                        description:
                                "Obsidian Vault内のフォルダ構成を一覧する(フォルダが先、ファイルが後)。vaultの構造確認や整理作業向け。pathは'sige/'付きの相対パス(省略時はvaultルート)。details:trueでサイズと更新日時(JST)も付く。depthは1〜3、デフォルト1。limit超過時は打ち切られる。",
                        inputSchema: z.object({
                                path: z.string().optional().describe("対象フォルダ(例: 'sige/10_Project')。省略時は'sige'"),
                                depth: z.number().int().min(1).max(3).optional().describe("掘る深さ(デフォルト1、最大3)"),
                                details: z.boolean().optional().describe("trueでサイズと更新日時を付ける(デフォルトfalse)"),
                                limit: z.number().int().min(1).max(500).optional().describe("最大件数(デフォルト200、最大500)"),
                        }),
                },
                async ({ path, depth, details, limit }) => {
                        try {
                                const base = path ?? "sige";
                                const d = depth ?? 1;
                                const r = await listFolderOnWrapper(env, base, d, details ?? false, limit ?? 200);
                                const fmtSize = (n: number) =>
                                        n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`;
                                const fmtTime = (iso: string) =>
                                        new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
                                const lines = r.entries.map((e) => {
                                        if (e.type === "d") return `d  ${e.path}/`;
                                        const extra =
                                                e.size !== undefined && e.mtime ? `  ${fmtSize(e.size)}  ${fmtTime(e.mtime)}` : "";
                                        return `f  ${e.path}${extra}`;
                                });
                                const head = `# ${base} depth=${d} ${r.count}件${r.truncated ? "(上限で打ち切り。limitかpathを調整)" : ""}`;
                                return { content: [{ type: "text", text: [head, ...lines].join("\n") }] };
                        } catch (err) {
                                return {
                                        content: [{ type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` }],
                                        isError: true,
                                };
                        }
                },
        );
//* 追加end */


        //note search tools start

        server.registerTool(
                "search_notes",
                {
                        description:
                                "Obsidian Vault内のノートを検索する。target:'path'(デフォルト)はファイル名・パスの部分一致(大文字小文字区別なし、本文は見ない高速検索)。target:'content'は本文の全文検索で、ヒットしたパスと前後の抜粋を返す。path_prefixで対象フォルダを絞れる(例: 'sige/40_Synapse/デイリーノート/')。",
                        inputSchema: z.object({
                                query: z.string().describe("探すキーワード(pathならファイル名/パスの一部、contentなら本文中の語)"),
                                target: z
                                        .enum(["path", "content"])
                                        .optional()
                                        .describe("'path'(デフォルト): ファイル名/パス検索、'content': 本文の全文検索"),
                                path_prefix: z
                                        .string()
                                        .optional()
                                        .describe("この文字列で始まるパスのファイルだけを対象にする"),
                                limit: z
                                        .number()
                                        .int()
                                        .min(1)
                                        .optional()
                                        .describe("最大何件返すか(pathのデフォルト20、contentは省略時無制限)"),
                        }),
                },
                async ({ query, target, path_prefix, limit }) => {
                        try {
                                if (target === "content") {
                                        const results = await searchNoteContentOnWrapper(env, query, path_prefix ?? "");
                                        const capped = limit ? results.slice(0, limit) : results;
                                        return {
                                                content: [
                                                        {
                                                                type: "text",
                                                                text: JSON.stringify(
                                                                        { hit_count: results.length, returned_count: capped.length, results: capped },
                                                                        null,
                                                                        2,
                                                                ),
                                                        },
                                                ],
                                        };
                                }

                                const paths = await listVaultMarkdownPaths(env);
                                const q = query.toLowerCase();
                                const matched = paths.filter(
                                        (p) => (!path_prefix || p.startsWith(path_prefix)) && p.toLowerCase().includes(q),
                                );
                                const capped = matched.slice(0, limit ?? 20);
                                return {
                                        content: [
                                                {
                                                        type: "text",
                                                        text: JSON.stringify(
                                                                { matched_count: matched.length, returned_count: capped.length, paths: capped },
                                                                null,
                                                                2,
                                                        ),
                                                },
                                        ],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        //note search tools end

        //note write tools start

        server.registerTool(
                "write_note",
                {
                        description:
                                "Obsidian Vaultのノート(Markdown)を書き込む。mode:'create'(デフォルト)は新規作成で、同名ファイルがあればエラー(誤上書き防止)。mode:'append'は既存ノートの末尾に追記。mode:'overwrite'は既存ノートを全文上書き。append/overwriteはノートが無いとエラー。一部だけ直すならoverwriteではなくedit_noteを使うこと。",
                        inputSchema: z.object({
                                path: z.string().describe("ノートのリポジトリルートからの相対パス(例: 'sige/00_Inbox/memo.md')"),
                                content: z.string().describe("書き込む内容(create/overwriteは全文、appendは追記分)"),
                                mode: z
                                        .enum(["create", "append", "overwrite"])
                                        .optional()
                                        .describe("'create'(デフォルト) / 'append' / 'overwrite'"),
                                separator: z
                                        .string()
                                        .optional()
                                        .describe("appendのとき既存本文と追記の間に挟む文字列(デフォルトは改行1つ '\\n')"),
                        }),
                },
                async ({ path, content, mode, separator }) => {
                        const m = mode ?? "create";
                        const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
                        try {
                                if (m === "create") {
                                        if (await noteExistsOnWrapper(env, path)) {
                                                return fail(
                                                        `エラー: ${path} は既に存在する。上書きならmode:'overwrite'、追記ならmode:'append'、一部修正ならedit_noteを使って。`,
                                                );
                                        }
                                        await putNoteToWrapper(env, path, content, "create_note");
                                        return { content: [{ type: "text", text: `作成した: ${path}` }] };
                                }

                                if (m === "append") {
                                        let existing: string;
                                        try {
                                                existing = await fetchNoteFromWrapper(env, path);
                                        } catch {
                                                return fail(`エラー: ${path} が見つからへん。先にmode:'create'で作成して。`);
                                        }
                                        await putNoteToWrapper(env, path, existing + (separator ?? "\n") + content, "append_to_note");
                                        return { content: [{ type: "text", text: `追記した: ${path}` }] };
                                }

                                if (!(await noteExistsOnWrapper(env, path))) {
                                        return fail(`エラー: ${path} が見つからへん。先にmode:'create'で作成して。`);
                                }
                                await putNoteToWrapper(env, path, content, "update_note");
                                return { content: [{ type: "text", text: `上書きした: ${path}` }] };
                        } catch (err) {
                                return fail(`エラー: ${err instanceof Error ? err.message : String(err)}`);
                        }
                },
        );

        server.registerTool(
                "delete_note",
                {
                        description:
                                "Obsidian Vault内の既存ノートを削除する。実際にはゴミ箱(90_Archive/Trash/日付/元のパス)へ移動し、30日後に自動で完全削除される。それまでは move_notes で元の場所に戻せる。ゴミ箱の中のノートを指定すると、その場で完全削除する。ノートが存在しない場合はエラーになる。更新から3分未満のノートは、同期の安全のため削除できない(少し待って再実行)。",
                        inputSchema: z.object({
                                path: z.string().describe("削除対象ノートのリポジトリルートからの相対パス"),
                        }),
                },
                async ({ path }) => {
                        try {
                                if (!(await noteExistsOnWrapper(env, path))) {
                                        return {
                                                content: [
                                                { type: "text", text: `エラー: ${path} が見つからへん。既に削除済みかパス間違いかも。` },
                                                ],
                                                isError: true,
                                        };
                                }
                                const r = await deleteNoteFromWrapper(env, path);
                                const text = r.trashPath
                                        ? `ゴミ箱に移動した: ${path} → sige/${r.trashPath}(${r.keepDays ?? 30}日後に完全削除。戻すなら move_notes)`
                                        : `完全削除した: ${path}`;
                                return {
                                        content: [{ type: "text", text }],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        /** move helper */
        server.registerTool(
                "move_notes",
                {
                        description:
                                "Obsidian Vault内のノート(またはファイル)を別のパスへ移動する。1回で最大50件。必ず最初にdry_run: true(デフォルト)で計画を作り、内容をユーザーに見せて承認を取ってからdry_run: falseで実行すること。移動先に同名ファイルがある場合は上書きせずskippedになる。パス指定のリンク([[フォルダ/ノート]]等)の書き換えはしない。実行後にskippedやerrorがあれば、必ずユーザーに報告すること。",
                        inputSchema: z.object({
                                moves: z
                                        .array(
                                                z.object({
                                                from: z
                                                .string()
                                                .describe("移動元のリポジトリルートからの相対パス(例: 'sige/00_Inbox/Clip/A.md')"),
                                                to: z
                                                .string()
                                                .describe(
                                                "移動先のリポジトリルートからの相対パス。ファイル名まで含める(例: 'sige/30_Resource/料理レシピ/A.md')",
                                                ),
                                                }),
                                        )
                                        .min(1)
                                        .max(50)
                                        .describe("移動の組のリスト(最大50件)"),
                                dry_run: z
                                        .boolean()
                                        .optional()
                                        .describe("true(デフォルト)なら計画だけ返して何も動かさない。実際に移動するときだけfalseを指定"),
                        }),
                },
                async ({ moves, dry_run }) => {
                        try {
                                const dryRun = dry_run ?? true;
                                const results = await moveNotesOnWrapper(env, moves, dryRun);
                                const count = (s: MoveResult["status"]) => results.filter((r) => r.status === s).length;
                                return {
                                        content: [
                                                {
                                                type: "text",
                                                text: JSON.stringify(
                                                {
                                                dry_run: dryRun,
                                                planned: count("planned"),
                                                moved: count("moved"),
                                                skipped: count("skipped"),
                                                error: count("error"),
                                                results,
                                                },
                                                null,
                                                2,
                                                ),
                                                },
                                        ],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );
// move register end

//note edit start
server.registerTool(
        "edit_note",
        {
                description:
                        "Obsidian Vault内の既存ノートを部分的に編集する(str_replace方式)。old_strがノート内にちょうど1か所だけ見つかる場合に、new_strへ置換する。0か所や複数か所の場合は何も変更せずエラーを返す(複数か所を意図して全部置換するときだけreplace_all: true)。editsを複数渡すと、すべて検証してから一括で適用し、1つでもNGなら何も変更しない。編集の前にread_noteで最新の内容を確認し、old_strは前後を含めて1か所に決まる長さにすること。frontmatterの1行や本文の一部のような小さな修正は、write_note(mode:'overwrite')ではなくこのツールを使うこと。同じノートへの同時編集は順番に処理される。対象は.md/.txt/.canvas/.baseのみ。dry_run: trueで、変更せずに一致箇所(行番号)だけ確認できる。",
                inputSchema: z.object({
                        path: z
                                .string()
                                .describe("編集対象ノートのリポジトリルートからの相対パス(例: 'sige/10_Project/メモ.md')"),
                        edits: z
                                .array(
                                        z.object({
                                                old_str: z
                                                .string()
                                                .describe(
                                                "置換前の文字列。ノート内にちょうど1か所だけ現れるよう、前後を含めた十分な長さにする。改行は\\nでよい",
                                                ),
                                                new_str: z.string().describe("置換後の文字列。空文字にするとold_strを削除する"),
                                                replace_all: z
                                                .boolean()
                                                .optional()
                                                .describe("trueにすると、old_strの全出現箇所を置換する。意図して全部置換するときだけ指定"),
                                        }),
                                )
                                .min(1)
                                .max(50)
                                .describe("編集のリスト(最大50件)。すべて元の内容に対して検証され、範囲が重なってはいけない"),
                        dry_run: z
                                .boolean()
                                .optional()
                                .describe("trueなら、変更せずに一致箇所(行番号)の確認だけをする。省略時はfalse(実際に編集する)"),
                }),
        },
        async ({ path, edits, dry_run }) => {
                try {
                        const dryRun = dry_run === true;
                        const r = await editNoteOnWrapper(env, path, edits, dryRun);
                        const summary = {
                                path: r.path,
                                dry_run: r.dryRun,
                                ok: r.ok,
                                applied: r.applied,
                                bytes_before: r.bytesBefore,
                                bytes_after: r.bytesAfter,
                                edits: r.edits,
                        };
                        if (!r.ok) {
                                return {
                                        content: [
                                                {
                                                type: "text",
                                                text: `エラー: 編集できなかった(ノートは何も変更していない)\n${JSON.stringify(summary, null, 2)}`,
                                                },
                                        ],
                                        isError: true,
                                };
                        }
                        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
                } catch (err) {
                        return {
                                content: [
                                        { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                ],
                                isError: true,
                        };
                }
        },
);

        //note write tools end


        //read file start
server.registerTool(
  "read_file",
  {
    title: "Read File",
    description: "Nextcloud上の指定ファイルの中身を読み込む。テキストファイルはそのまま、バイナリファイルはbase64で返す。",
    inputSchema: {
      path: z.string().describe("読み込むファイルのパス（例: 'Documents/memo.md'）")
    }
  },
  async ({ path }) => {
    const result = await readFile(path, env);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);
//read file end

//upload file start
server.registerTool(
  "upload_file",
  {
    title: "Upload File",
    description: "Nextcloudの指定パスにファイルをアップロードする。既存ファイルがあれば上書きする。",
    inputSchema: {
      path: z.string().describe("保存先のパス（例: 'Documents/memo.md'）"),
      content: z.string().describe("ファイルの中身（テキスト）")
    }
  },
  async ({ path, content }) => {
    const result = await uploadFile(path, content, env);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);
//upload file end

//delete file start
server.registerTool(
  "delete_file",
  {
    title: "Delete File",
    description: "Nextcloud上の指定ファイルを削除する。削除は取り消せないので、確実に消したいファイルのpathを指定すること。",
    inputSchema: {
      path: z.string().describe("削除するファイルのパス（例: 'Documents/memo.md'）")
    }
  },
  async ({ path }) => {
    const result = await deleteFile(path, env);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);
//delete file end

//create folder start
server.registerTool(
  "create_folder",
  {
    title: "Create Folder",
    description: "Nextcloudの指定パスにフォルダを新規作成する。親フォルダが存在しない場合は失敗する。",
    inputSchema: {
      path: z.string().describe("作成するフォルダのパス（例: 'Documents/新しいフォルダ/'。末尾のスラッシュ推奨）")
    }
  },
  async ({ path }) => {
    const result = await createFolder(path, env);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);
//create folder end

        //list files start
        server.registerTool(
          "list_files",
          {
            title: "List Files",
            description: "Nextcloudの指定フォルダ内のファイル・フォルダ一覧を取得する",
            inputSchema: {
              path: z.string().describe("一覧取得したいフォルダのパス（例: 'Documents/' や '' でルート直下）")
            }
          },
          async ({ path }) => {
            const items = await listFiles(path, env);
            return {
              content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
            };
          }
        );
        //list files end

        //calendar tools start

        server.registerTool(
                "list_calendar_events",
                {
                        description: "指定期間内のカレンダー予定一覧をNextcloudから取得する。",
                        inputSchema: z.object({
                                start: z.string().describe("検索開始日時 (日本時間/JST, 例: 2026-08-01T00:00:00)"),
                                end: z.string().describe("検索終了日時 (日本時間/JST, 例: 2026-08-31T23:59:59)"),
                        }),
                },
                async ({ start, end }) => {
                        try {
                                const body = `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toICSDate(start)}" end="${toICSDate(end)}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

                                const res = await fetch(calendarUrl(env), {
                                        method: "REPORT",
                                        headers: {
                                                Authorization: authHeader(env),
                                                "Content-Type": "application/xml; charset=utf-8",
                                                Depth: "1",
                                        },
                                        body,
                                });

                                if (!res.ok) {
                                        throw new Error(`一覧取得に失敗: ${res.status} ${await res.text()}`);
                                }

                                const xml = await res.text();
                                // サーバーが返す名前空間接頭辞(cal:など)はリクエスト側と揃う保証がないため、
                                // 接頭辞を問わず "calendar-data" タグを拾う正規表現にしている。
                                const matches = [
                                        ...xml.matchAll(/<[\w-]+:calendar-data[^>]*>([\s\S]*?)<\/[\w-]+:calendar-data>/g),
                                ];
                                const events = matches.map((m) => parseICS(decodeXmlEntities(m[1])));

                                return {
                                        content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        server.registerTool(
                "save_calendar_event",
                {
                        description:
                                "Nextcloudカレンダーの予定を作成または更新する。uidを省略すると新規作成、uid(list_calendar_eventsで取得)を指定するとその予定を更新する。更新は全項目上書きなので、変えない項目も現在の値を渡すこと。",
                        inputSchema: z.object({
                                uid: z.string().optional().describe("更新対象のUID。省略時は新規作成"),
                                summary: z.string().describe("予定のタイトル"),
                                start: z.string().describe("開始日時 (日本時間/JST, 例: 2026-08-14T11:00:00)"),
                                end: z.string().describe("終了日時 (日本時間/JST, 例: 2026-08-14T12:00:00)"),
                                description: z.string().optional().describe("予定の詳細メモ"),
                        }),
                },
                async ({ uid, summary, start, end, description }) => {
                        try {
                                const isNew = !uid;
                                const id = uid ?? crypto.randomUUID();
                                const ics = buildICS({ uid: id, summary, start, end, description });

                                const res = await fetch(`${calendarUrl(env)}${id}.ics`, {
                                        method: "PUT",
                                        headers: {
                                                Authorization: authHeader(env),
                                                "Content-Type": "text/calendar; charset=utf-8",
                                                // 新規はUIDの衝突防止、更新は存在しない予定を勝手に作らない
                                                ...(isNew ? { "If-None-Match": "*" } : { "If-Match": "*" }),
                                        },
                                        body: ics,
                                });

                                if (res.status === 412 && !isNew) {
                                        throw new Error(`UID ${id} の予定が見つからへん。list_calendar_eventsで確認して。`);
                                }
                                if (!res.ok) {
                                        throw new Error(`${isNew ? "作成" : "更新"}に失敗: ${res.status} ${await res.text()}`);
                                }

                                return {
                                        content: [{ type: "text", text: `予定を${isNew ? "作成" : "更新"}した。UID: ${id}` }],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        server.registerTool(
                "delete_calendar_event",
                {
                        description: "Nextcloudカレンダーの予定をUID指定で削除する。",
                        inputSchema: z.object({
                                uid: z.string().describe("削除対象イベントのUID (list_calendar_eventsで取得したもの)"),
                        }),
                },
                async ({ uid }) => {
                        try {
                                const res = await fetch(`${calendarUrl(env)}${uid}.ics`, {
                                        method: "DELETE",
                                        headers: {
                                                Authorization: authHeader(env),
                                        },
                                });

                                if (!res.ok && res.status !== 404) {
                                        throw new Error(`削除に失敗: ${res.status} ${await res.text()}`);
                                }

                                return {
                                        content: [{ type: "text", text: `予定を削除した。UID: ${uid}` }],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        //calendar tools end

        //task tools start

        server.registerTool(
                "list_tasks",
                {
                        description:
                                "Nextcloudのタスク(リマインダー)を取得する。返り値のlistsにタスクリスト一覧(id/displayname)、tasksにタスクが入る。他のタスク系ツールにはこのlistのidを渡す。listId省略時は全リストから取得。",
                        inputSchema: z.object({
                                listId: z.string().optional().describe("対象リストのid。省略時は全リスト"),
                                include_completed: z
                                        .boolean()
                                        .optional()
                                        .describe("完了済みタスクも含めるか (デフォルト: false)"),
                        }),
                },
                async ({ listId, include_completed }) => {
                        try {
                                const lists = await getTaskLists(env);
                                const targets = listId ? [listId] : lists.map((c) => c.id);

                                const body = `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO" />
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

                                const tasks: any[] = [];
                                for (const id of targets) {
                                        const res = await fetch(taskCalendarUrl(env, id), {
                                                method: "REPORT",
                                                headers: {
                                                        Authorization: authHeader(env),
                                                        "Content-Type": "application/xml; charset=utf-8",
                                                        Depth: "1",
                                                },
                                                body,
                                        });
                                        if (!res.ok) continue; // 個別リストの取得失敗は無視して他を続行
                                        const xml = await res.text();
                                        const matches = [
                                                ...xml.matchAll(/<[\w-]+:calendar-data[^>]*>([\s\S]*?)<\/[\w-]+:calendar-data>/g),
                                        ];
                                        for (const m of matches) {
                                                const task = parseVTODO(decodeXmlEntities(m[1]));
                                                if (!include_completed && task.status === "COMPLETED") continue;
                                                tasks.push({ listId: id, ...task });
                                        }
                                }

                                return {
                                        content: [{ type: "text", text: JSON.stringify({ lists, tasks }, null, 2) }],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        server.registerTool(
                "save_task",
                {
                        description:
                                "Nextcloudのタスクを作成または更新する。uidを省略すると新規作成(summary必須)。uid(list_tasksで取得)を指定すると、渡した項目だけを変更し、他は保持する。完了にするにはstatus:'completed'、未完了に戻すにはstatus:'needs_action'。dueやdescriptionを消すには空文字を渡す。",
                        inputSchema: z.object({
                                listId: z.string().describe("リストのid (list_tasksのlists[].id)"),
                                uid: z.string().optional().describe("更新対象タスクのUID。省略時は新規作成"),
                                summary: z.string().optional().describe("タスクのタイトル(新規作成時は必須)"),
                                due: z
                                        .string()
                                        .optional()
                                        .describe("期限日時 (日本時間/JST, 例: 2026-08-20T09:00:00)。空文字で期限を削除"),
                                priority: z.enum(["high", "medium", "low", "none"]).optional().describe("緊急度"),
                                description: z.string().optional().describe("メモ。空文字で削除"),
                                status: z
                                        .enum(["needs_action", "in_process", "completed"])
                                        .optional()
                                        .describe("状態。'completed'で完了扱い"),
                        }),
                },
                async ({ listId, uid, summary, due, priority, description, status }) => {
                        try {
                                if (!uid) {
                                        if (!summary) throw new Error("新規作成にはsummaryが必要。");
                                        const newUid = crypto.randomUUID();
                                        const ics = buildVTODO({
                                                uid: newUid,
                                                summary,
                                                due: due || undefined,
                                                priority,
                                                description: description || undefined,
                                                status,
                                        });
                                        const res = await fetch(`${taskCalendarUrl(env, listId)}${newUid}.ics`, {
                                                method: "PUT",
                                                headers: {
                                                        Authorization: authHeader(env),
                                                        "Content-Type": "text/calendar; charset=utf-8",
                                                        "If-None-Match": "*",
                                                },
                                                body: ics,
                                        });
                                        if (!res.ok) throw new Error(`作成に失敗: ${res.status} ${await res.text()}`);
                                        return { content: [{ type: "text", text: `タスクを作成した。UID: ${newUid}` }] };
                                }

                                const url = `${taskCalendarUrl(env, listId)}${uid}.ics`;
                                const getRes = await fetch(url, { method: "GET", headers: { Authorization: authHeader(env) } });
                                if (getRes.status === 404) throw new Error(`UID ${uid} のタスクが見つからへん。listIdとuidを確認して。`);
                                if (!getRes.ok) throw new Error(`取得に失敗: ${getRes.status} ${await getRes.text()}`);
                                const etag = getRes.headers.get("ETag");
                                const ics = patchVTODO(await getRes.text(), { summary, due, priority, description, status });

                                const putRes = await fetch(url, {
                                        method: "PUT",
                                        headers: {
                                                Authorization: authHeader(env),
                                                "Content-Type": "text/calendar; charset=utf-8",
                                                // 読んでから書くまでに他所で変更されていたら上書きしない
                                                ...(etag ? { "If-Match": etag } : {}),
                                        },
                                        body: ics,
                                });
                                if (putRes.status === 412) throw new Error("取得後にタスクが他で変更された。もう一度実行して。");
                                if (!putRes.ok) throw new Error(`更新に失敗: ${putRes.status} ${await putRes.text()}`);

                                return { content: [{ type: "text", text: `タスクを更新した。UID: ${uid}` }] };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        server.registerTool(
                "delete_task",
                {
                        description: "タスクをUID指定で削除する。",
                        inputSchema: z.object({
                                listId: z.string().describe("対象リストのid"),
                                uid: z.string().describe("削除対象タスクのUID"),
                        }),
                },
                async ({ listId, uid }) => {
                        try {
                                const res = await fetch(`${taskCalendarUrl(env, listId)}${uid}.ics`, {
                                        method: "DELETE",
                                        headers: { Authorization: authHeader(env) },
                                });
                                if (!res.ok && res.status !== 404) {
                                        throw new Error(`削除に失敗: ${res.status} ${await res.text()}`);
                                }
                                return {
                                        content: [{ type: "text", text: `タスクを削除した。UID: ${uid}` }],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        //task tools end

        //task list management tools start

        server.registerTool(
                "manage_task_list",
                {
                        description:
                                "タスクリストを作成または改名する。action:'create'はdisplaynameで新規作成。action:'rename'はid(list_tasksのlists[].id)のリストをdisplaynameに改名。削除はdelete_task_listを使う。",
                        inputSchema: z.object({
                                action: z.enum(["create", "rename"]).describe("'create' または 'rename'"),
                                displayname: z.string().describe("リストの表示名 (例: 買い物, 仕事)。renameでは変更後の名前"),
                                id: z.string().optional().describe("renameの対象リストのid"),
                        }),
                },
                async ({ action, displayname, id }) => {
                        try {
                                if (action === "create") {
                                        const newId = crypto.randomUUID();
                                        // Cloudflare Workersのfetch()はMKCALENDARメソッドを受け付けないため、
                                        // RFC5689 (Extended MKCOL) に従い、標準のMKCOLメソッド+ボディでresourcetypeに
                                        // calendarを含めることでカレンダーコレクションを作成する(SabreDAV/Nextcloudが対応)。
                                        const body = `<?xml version="1.0" encoding="utf-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:resourcetype>
        <d:collection/>
        <c:calendar/>
      </d:resourcetype>
      <d:displayname>${escapeXml(displayname)}</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VTODO"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</d:mkcol>`;
                                        const res = await fetch(`${calendarsBaseUrl(env)}${newId}/`, {
                                                method: "MKCOL",
                                                headers: {
                                                        Authorization: authHeader(env),
                                                        "Content-Type": "application/xml; charset=utf-8",
                                                },
                                                body,
                                        });
                                        if (!res.ok) throw new Error(`作成に失敗: ${res.status} ${await res.text()}`);
                                        return {
                                                content: [{ type: "text", text: `タスクリスト「${displayname}」を作成した。id: ${newId}` }],
                                        };
                                }

                                if (!id) throw new Error("renameにはidが必要。");
                                const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:">
  <d:set>
    <d:prop>
      <d:displayname>${escapeXml(displayname)}</d:displayname>
    </d:prop>
  </d:set>
</d:propertyupdate>`;
                                const res = await fetch(`${calendarsBaseUrl(env)}${id}/`, {
                                        method: "PROPPATCH",
                                        headers: {
                                                Authorization: authHeader(env),
                                                "Content-Type": "application/xml; charset=utf-8",
                                        },
                                        body,
                                });
                                if (!res.ok) throw new Error(`改名に失敗: ${res.status} ${await res.text()}`);
                                return { content: [{ type: "text", text: `表示名を「${displayname}」に変更した。` }] };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        server.registerTool(
                "delete_task_list",
                {
                        description:
                                "タスクリストを削除する。中のタスクも全て消える破壊的操作なので、実行前に必ずユーザーに確認すること。",
                        inputSchema: z.object({
                                id: z.string().describe("削除対象リストのid (list_tasksのlists[].id)"),
                        }),
                },
                async ({ id }) => {
                        try {
                                const res = await fetch(`${calendarsBaseUrl(env)}${id}/`, {
                                        method: "DELETE",
                                        headers: { Authorization: authHeader(env) },
                                });
                                if (!res.ok && res.status !== 404) {
                                        throw new Error(`削除に失敗: ${res.status} ${await res.text()}`);
                                }
                                return {
                                        content: [{ type: "text", text: `タスクリストを削除した。id: ${id}` }],
                                };
                        } catch (err) {
                                return {
                                        content: [
                                                { type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` },
                                        ],
                                        isError: true,
                                };
                        }
                },
        );

        //task list management tools end

        return server;
}

/**
 * OAuthProviderのapiHandlerはfetchメソッドを持つオブジェクトを要求する。
 * リクエストごとにenvを閉じ込めたcreateServer(env)を組み立て直すことで、
 * ツール内で確実にWRAPPER_AUTH_TOKEN等のSecretsにアクセスできるようにしている。
 */
const apiFetch = async (request: Request, env: Env, ctx: ExecutionContext) => {
        const handler = createMcpHandler(() => createServer(env));
        return handler(request, env, ctx);
};

export default new OAuthProvider({
        apiRoute: "/mcp",
        apiHandler: { fetch: apiFetch },
        defaultHandler: AccessHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        // 動的登録クライアントはデフォルト90日で失効し、claude.ai側が古いclient_idを
        // 持ったまま認証開始できなくなる。明示的にundefinedを渡して無期限にする。
        clientRegistrationTTL: undefined,
});
