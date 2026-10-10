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
	tool: "create_note" | "append_to_note" | "update_note",
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

/** ノートのリビジョン・コンフリクト有無を取得する(check_conflicts用) */
async function fetchNoteInfoFromWrapper(
	env: Env,
	repoPath: string,
): Promise<{ path: string; size: number; mtime: string; revision?: string; conflicts?: string; checked?: boolean; hasConflict?: boolean; conflictRevs?: string[]; deleted?: boolean; cliError?: string }> {
	const p = toWrapperPath(repoPath);
	const res = await wrapperFetch(env, `/info?path=${encodeURIComponent(p)}`);
	if (res.status === 404) throw new Error(`ノートが見つからへんかった: ${repoPath}`);
	if (!res.ok) throw new Error(`ラッパーAPIエラー (${res.status}): ${await res.text()}`);
	const data = (await res.json()) as {
		path: string;
		size: number;
		mtime: string;
		revision?: string;
		conflicts?: string;
		checked?: boolean;
		hasConflict?: boolean;
		conflictRevs?: string[];
		deleted?: boolean;
		cliError?: string;
	};
	return { ...data, path: fromWrapperPath(data.path) };
}

/**
 * コンフリクトを解消する(指定revを残し、他の競合revを表示上除外する)。
 * 注意: 物理削除ではない。CouchDBのMVCC的性質により、除外されたrevも
 * livesync-cliのcat-rev等で後から読み出せる。
 */
async function resolveConflictOnWrapper(env: Env, repoPath: string, rev: string): Promise<string> {
	const p = toWrapperPath(repoPath);
	const res = await wrapperFetch(env, `/resolve`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-MCP-Tool": "resolve_conflict" },
		body: JSON.stringify({ path: p, rev }),
	});
	if (!res.ok) throw new Error(`コンフリクト解消に失敗 (${res.status}): ${await res.text()}`);
	const data = (await res.json()) as { status: string; keptRev: string; output?: string };
	return data.output ?? data.status;
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

// 個別タスクリストのURL。idはlist_tasklistsで取得したhref末尾の部分。
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
 * list_tasklists と list_tasks(listId省略時) の両方から使う。
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
				displayname: nameMatch ? nameMatch[1] : "(no name)",
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
	const now = toICSDate(new Date().toISOString());
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
		`SUMMARY:${params.summary}`,
		params.due ? `DUE:${toICSDate(params.due)}` : "",
		params.priority && params.priority !== "none"
			? `PRIORITY:${PRIORITY_MAP[params.priority]}`
			: "",
		`STATUS:${status}`,
		isCompleted ? `COMPLETED:${now}` : "",
		isCompleted ? "PERCENT-COMPLETE:100" : "",
		params.description ? `DESCRIPTION:${params.description}` : "",
		"END:VTODO",
		"END:VCALENDAR",
	]
		.filter(Boolean)
		.join("\r\n");
}

function parseVTODO(ics: string) {
	const vtodoMatch = ics.match(/BEGIN:VTODO([\s\S]*?)END:VTODO/);
	const body = vtodoMatch ? vtodoMatch[1] : ics;
	const get = (key: string) => {
		const m = body.match(new RegExp(`${key}(?:;[^:\\r\\n]*)?:(.*)`));
		return m ? m[1].trim() : undefined;
	};
	const priorityRaw = get("PRIORITY");
	return {
		uid: get("UID"),
		summary: get("SUMMARY"),
		due: get("DUE"),
		priority: priorityLabel(priorityRaw ? Number(priorityRaw) : undefined),
		status: get("STATUS"),
		description: get("DESCRIPTION"),
	};
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
	const now = toICSDate(new Date().toISOString());
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//shigepi-mcp//caldav-tool//JP",
		"BEGIN:VEVENT",
		`UID:${params.uid}`,
		`DTSTAMP:${now}`,
		`DTSTART:${toICSDate(params.start)}`,
		`DTEND:${toICSDate(params.end)}`,
		`SUMMARY:${params.summary}`,
		params.description ? `DESCRIPTION:${params.description}` : "",
		"END:VEVENT",
		"END:VCALENDAR",
	]
		.filter(Boolean)
		.join("\r\n");
}

// 超簡易ICSパーサー（一覧表示に必要な項目だけ抜く）
function parseICS(ics: string) {
	// VTIMEZONE内にも DTSTART 等の同名プロパティが出てくるため、
	// VEVENT本体だけを切り出してからプロパティを拾う。
	const veventMatch = ics.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/);
	const body = veventMatch ? veventMatch[1] : ics;

	const get = (key: string) => {
		// "KEY:value" と "KEY;PARAM=xxx:value" の両方に対応
		const m = body.match(new RegExp(`${key}(?:;[^:\\r\\n]*)?:(.*)`));
		return m ? m[1].trim() : undefined;
	};
	return {
		uid: get("UID"),
		summary: get("SUMMARY"),
		start: get("DTSTART"),
		end: get("DTEND"),
		description: get("DESCRIPTION"),
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
				"Obsidian Vault内の指定パスのノート(Markdownファイル)を1本読み込む。pathはリポジトリルートからの相対パス(例: 'sige/daily/2026-08-12.md')。",
			inputSchema: z.object({
				path: z.string().describe("リポジトリルートからの相対パス"),
			}),
		},
		async ({ path }) => {
			try {
				const content = await fetchNoteFromWrapper(env, path);
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
				"Obsidian Vault内の指定フォルダ配下にある全ノート(.md)の中身を一括取得する。フォルダ内の複数ノートをまとめて読みたい時、search_notesで一覧を取ってから1件ずつread_noteするより高速。prefixはリポジトリルートからの相対パス(例: 'sige/10_Projects/oracle migrate')。",
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
				path: z.string().optional().describe("対象フォルダ(例: 'sige/10_Projects')。省略時は'sige'"),
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
				"Obsidian Vault内のノートをファイル名・パスで検索する。queryはファイル名やフォルダ名の一部(部分一致、大文字小文字区別なし)。本文の中身は見ない、パスだけの高速検索。",
			inputSchema: z.object({
				query: z.string().describe("ファイル名/パスに含まれるキーワード"),
				limit: z
					.number()
					.optional()
					.describe("最大何件返すか(デフォルト20)"),
			}),
		},
		async ({ query, limit }) => {
			try {
				const paths = await listVaultMarkdownPaths(env);
				const q = query.toLowerCase();
				const matched = paths.filter((p) => p.toLowerCase().includes(q));
				const capped = matched.slice(0, limit ?? 20);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									matched_count: matched.length,
									returned_count: capped.length,
									paths: capped,
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

	server.registerTool(
		"search_note_content",
		{
			description:
				"Obsidian Vault内のノートの本文中身を全文検索する。ヒットしたファイルのパスと前後の抜粋(スニペット)を返す。VPS上のfsを直接検索するので、Vaultサイズによる制限は実質ない。",
			inputSchema: z.object({
				query: z.string().describe("本文中で探すキーワード"),
				path_prefix: z
					.string()
					.optional()
					.describe("この文字列で始まるパスのファイルだけを対象にする(例: 'sige/daily/')"),
			}),
		},
		async ({ query, path_prefix }) => {
			try {
				const results = await searchNoteContentOnWrapper(env, query, path_prefix ?? "");

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									hit_count: results.length,
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

	//note search tools end

	//note write tools start

	server.registerTool(
		"create_note",
		{
			description:
				"Obsidian Vault内に新規ノート(Markdownファイル)を作成する。同名のファイルが既にある場合はエラーになる(誤上書き防止のため)。既存ノートを変更したい場合はupdate_noteかappend_to_noteを使うこと。",
			inputSchema: z.object({
				path: z.string().describe("作成するノートのリポジトリルートからの相対パス(例: 'sige/memo.md')"),
				content: z.string().describe("ノートの中身(Markdown本文)"),
			}),
		},
		async ({ path, content }) => {
			try {
				if (await noteExistsOnWrapper(env, path)) {
					return {
						content: [
							{
								type: "text",
								text: `エラー: ${path} は既に存在する。上書きしたいならupdate_note、追記したいならappend_to_noteを使って。`,
							},
						],
						isError: true,
					};
				}
				await putNoteToWrapper(env, path, content, "create_note");
				return {
					content: [{ type: "text", text: `作成した: ${path}` }],
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
		"append_to_note",
		{
			description:
				"既存ノートの末尾にテキストを追記する。ノートが存在しない場合はエラーになるので、先にcreate_noteで作成すること。",
			inputSchema: z.object({
				path: z.string().describe("追記対象ノートのリポジトリルートからの相対パス"),
				content: z.string().describe("追記するテキスト"),
				separator: z
					.string()
					.optional()
					.describe("既存本文と追記内容の間に挟む文字列(デフォルトは改行1つ '\\n')"),
			}),
		},
		async ({ path, content, separator }) => {
			try {
				let existing: string;
				try {
					existing = await fetchNoteFromWrapper(env, path);
				} catch {
					return {
						content: [
							{
								type: "text",
								text: `エラー: ${path} が見つからへん。先にcreate_noteで作成して。`,
							},
						],
						isError: true,
					};
				}
				const newContent = existing + (separator ?? "\n") + content;
				await putNoteToWrapper(env, path, newContent, "append_to_note");
				return {
					content: [{ type: "text", text: `追記した: ${path}` }],
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
		"update_note",
		{
			description:
				"既存ノートの中身を丸ごと上書きする。ノートが存在しない場合はエラーになるので、先にcreate_noteで作成すること。部分的な変更をしたい場合は事前にread_noteで現在の中身を取得し、変更後の全文をcontentに渡すこと。",
			inputSchema: z.object({
				path: z.string().describe("上書き対象ノートのリポジトリルートからの相対パス"),
				content: z.string().describe("新しいノートの中身(全文、Markdown)"),
			}),
		},
		async ({ path, content }) => {
			try {
				if (!(await noteExistsOnWrapper(env, path))) {
					return {
						content: [
							{
								type: "text",
								text: `エラー: ${path} が見つからへん。先にcreate_noteで作成して。`,
							},
						],
						isError: true,
					};
				}
				await putNoteToWrapper(env, path, content, "update_note");
				return {
					content: [{ type: "text", text: `更新した: ${path}` }],
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

	server.registerTool(
		"check_conflicts",
		{
			description:
				"指定ノートにLiveSync同期のコンフリクト(競合)が起きてないか確認する。revisionと(あれば)conflictsのrevを返す。resolve_conflictを使う前に必ずこれで状況確認すること。",
			inputSchema: z.object({
				path: z.string().describe("確認対象ノートのリポジトリルートからの相対パス"),
			}),
		},
		async ({ path }) => {
			try {
				const info = await fetchNoteInfoFromWrapper(env, path);
				// checked !== true or no revision means we could not verify: never report no conflict
				const verified = info.checked === true && !!info.revision;
				const hasConflict: boolean | "unknown" = verified
				  ? (info.hasConflict ?? (!!info.conflicts && info.conflicts !== "N/A"))
				  : "unknown";
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									path: info.path,
									revision: info.revision,
									conflicts: info.conflicts,
									has_conflict: hasConflict,
									reason: hasConflict === "unknown" ? (info.cliError ?? "could not verify conflicts") : undefined,
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

	server.registerTool(
		"resolve_conflict",
		{
			description:
				"LiveSync同期のコンフリクトを解消する。指定したrevを正としてkeepし、他の競合revは表示上除外される(物理削除ではないので後から復元可能)。低頻度・人間の判断が必要な操作なので、先にcheck_conflictsで状況を確認し、どちらの版を残すかユーザー本人に確認を取ってから使うこと。Claude自身の判断だけで勝手にどちらかを選んで実行しない。",
			inputSchema: z.object({
				path: z.string().describe("対象ノートのリポジトリルートからの相対パス"),
				rev: z
					.string()
					.describe("残す(keepする)リビジョンID。check_conflictsで事前に確認したものを渡すこと"),
			}),
		},
		async ({ path, rev }) => {
			try {
				const output = await resolveConflictOnWrapper(env, path, rev);
				return {
					content: [
						{ type: "text", text: `コンフリクトを解消した: ${path} (keep rev: ${rev})\n${output}` },
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
								.describe("移動元のリポジトリルートからの相対パス(例: 'sige/00_Inbox/Clippings/A.md')"),
							to: z
								.string()
								.describe(
									"移動先のリポジトリルートからの相対パス。ファイル名まで含める(例: 'sige/30_Resources/料理レシピ/A.md')",
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
			"Obsidian Vault内の既存ノートを部分的に編集する(str_replace方式)。old_strがノート内にちょうど1か所だけ見つかる場合に、new_strへ置換する。0か所や複数か所の場合は何も変更せずエラーを返す(複数か所を意図して全部置換するときだけreplace_all: true)。editsを複数渡すと、すべて検証してから一括で適用し、1つでもNGなら何も変更しない。編集の前にread_noteで最新の内容を確認し、old_strは前後を含めて1か所に決まる長さにすること。frontmatterの1行や本文の一部のような小さな修正は、update_note(全文上書き)ではなくこのツールを使うこと。同じノートへの同時編集は順番に処理される。対象は.md/.txt/.canvas/.baseのみ。dry_run: trueで、変更せずに一致箇所(行番号)だけ確認できる。",
		inputSchema: z.object({
			path: z
				.string()
				.describe("編集対象ノートのリポジトリルートからの相対パス(例: 'sige/10_Projects/メモ.md')"),
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
				const events = matches.map((m) => parseICS(m[1]));

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
		"create_calendar_event",
		{
			description: "Nextcloudカレンダーに新しい予定を作成する。",
			inputSchema: z.object({
				summary: z.string().describe("予定のタイトル"),
				start: z.string().describe("開始日時 (日本時間/JST, 例: 2026-08-14T11:00:00)"),
				end: z.string().describe("終了日時 (日本時間/JST, 例: 2026-08-14T12:00:00)"),
				description: z.string().optional().describe("予定の詳細メモ"),
			}),
		},
		async ({ summary, start, end, description }) => {
			try {
				const uid = crypto.randomUUID();
				const ics = buildICS({ uid, summary, start, end, description });

				const res = await fetch(`${calendarUrl(env)}${uid}.ics`, {
					method: "PUT",
					headers: {
						Authorization: authHeader(env),
						"Content-Type": "text/calendar; charset=utf-8",
					},
					body: ics,
				});

				if (!res.ok) {
					throw new Error(`作成に失敗: ${res.status} ${await res.text()}`);
				}

				return {
					content: [{ type: "text", text: `予定を作成した。UID: ${uid}` }],
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
		"update_calendar_event",
		{
			description: "既存のNextcloudカレンダー予定をUID指定で更新する(内容は全項目上書き)。",
			inputSchema: z.object({
				uid: z.string().describe("変更対象イベントのUID (list_calendar_eventsで取得したもの)"),
				summary: z.string().describe("予定のタイトル(変更後)"),
				start: z.string().describe("開始日時 (日本時間/JST, 変更後, 例: 2026-08-14T11:00:00)"),
				end: z.string().describe("終了日時 (日本時間/JST, 変更後, 例: 2026-08-14T12:00:00)"),
				description: z.string().optional().describe("予定の詳細メモ(変更後)"),
			}),
		},
		async ({ uid, summary, start, end, description }) => {
			try {
				const ics = buildICS({ uid, summary, start, end, description });

				const res = await fetch(`${calendarUrl(env)}${uid}.ics`, {
					method: "PUT",
					headers: {
						Authorization: authHeader(env),
						"Content-Type": "text/calendar; charset=utf-8",
					},
					body: ics,
				});

				if (!res.ok) {
					throw new Error(`更新に失敗: ${res.status} ${await res.text()}`);
				}

				return {
					content: [{ type: "text", text: `予定を更新した。UID: ${uid}` }],
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

	//task list management tools start

	server.registerTool(
		"list_tasklists",
		{
			description:
				"Nextcloud上のタスクリスト(カレンダーコレクション)を一覧取得する。id(不変の識別子)とdisplayname(表示名)を返す。他のタスク系ツールにはこのidを渡す。",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const calendars = await getTaskLists(env);
				return {
					content: [{ type: "text", text: JSON.stringify(calendars, null, 2) }],
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
		"create_task_list",
		{
			description: "新しいタスクリスト(カレンダーコレクション)を作成する。",
			inputSchema: z.object({
				displayname: z.string().describe("リストの表示名 (例: 買い物, 仕事)"),
			}),
		},
		async ({ displayname }) => {
			try {
				const id = crypto.randomUUID();
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

				const res = await fetch(`${calendarsBaseUrl(env)}${id}/`, {
					method: "MKCOL",
					headers: {
						Authorization: authHeader(env),
						"Content-Type": "application/xml; charset=utf-8",
					},
					body,
				});
				if (!res.ok) {
					throw new Error(`作成に失敗: ${res.status} ${await res.text()}`);
				}

				return {
					content: [
						{ type: "text", text: `タスクリスト「${displayname}」を作成した。id: ${id}` },
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

	server.registerTool(
		"rename_task_list",
		{
			description: "既存タスクリストの表示名を変更する。idはlist_tasklistsで取得したものを使う。",
			inputSchema: z.object({
				id: z.string().describe("対象リストのid (list_tasklistsのidフィールド)"),
				new_displayname: z.string().describe("変更後の表示名"),
			}),
		},
		async ({ id, new_displayname }) => {
			try {
				const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:">
  <d:set>
    <d:prop>
      <d:displayname>${escapeXml(new_displayname)}</d:displayname>
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
				if (!res.ok) {
					throw new Error(`改名に失敗: ${res.status} ${await res.text()}`);
				}

				return {
					content: [{ type: "text", text: `表示名を「${new_displayname}」に変更した。` }],
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
		"delete_task_list",
		{
			description:
				"タスクリストを削除する。中のタスクも全て消える破壊的操作なので、実行前に必ずユーザーに確認すること。",
			inputSchema: z.object({
				id: z.string().describe("削除対象リストのid (list_tasklistsのidフィールド)"),
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

	//task tools start

	server.registerTool(
		"list_tasks",
		{
			description:
				"タスク(リマインダー)一覧を取得する。listId未指定時は全リストから取得する。",
			inputSchema: z.object({
				listId: z
					.string()
					.optional()
					.describe("対象リストのid (list_tasklistsのidフィールド)。省略時は全リスト"),
				include_completed: z
					.boolean()
					.optional()
					.describe("完了済みタスクも含めるか (デフォルト: false)"),
			}),
		},
		async ({ listId, include_completed }) => {
			try {
				const targets = listId ? [listId] : (await getTaskLists(env)).map((c) => c.id);

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

				const allTasks: any[] = [];
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
						const task = parseVTODO(m[1]);
						if (!include_completed && task.status === "COMPLETED") continue;
						allTasks.push({ listId: id, ...task });
					}
				}

				return {
					content: [{ type: "text", text: JSON.stringify(allTasks, null, 2) }],
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
		"create_task",
		{
			description: "指定リストに新しいタスク(リマインダー)を作成する。",
			inputSchema: z.object({
				listId: z.string().describe("作成先リストのid (list_tasklistsのidフィールド)"),
				summary: z.string().describe("タスクのタイトル"),
				due: z
					.string()
					.optional()
					.describe("期限日時 (日本時間/JST, 例: 2026-08-20T09:00:00)"),
				priority: z
					.enum(["high", "medium", "low", "none"])
					.optional()
					.describe("緊急度"),
				description: z.string().optional().describe("メモ"),
			}),
		},
		async ({ listId, summary, due, priority, description }) => {
			try {
				const uid = crypto.randomUUID();
				const ics = buildVTODO({ uid, summary, due, priority, description });

				const res = await fetch(`${taskCalendarUrl(env, listId)}${uid}.ics`, {
					method: "PUT",
					headers: {
						Authorization: authHeader(env),
						"Content-Type": "text/calendar; charset=utf-8",
					},
					body: ics,
				});
				if (!res.ok) {
					throw new Error(`作成に失敗: ${res.status} ${await res.text()}`);
				}

				return {
					content: [{ type: "text", text: `タスクを作成した。UID: ${uid}` }],
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
		"update_task",
		{
			description: "既存タスクをUID指定で更新する(内容は全項目上書き)。",
			inputSchema: z.object({
				listId: z.string().describe("対象リストのid"),
				uid: z.string().describe("変更対象タスクのUID (list_tasksで取得したもの)"),
				summary: z.string().describe("タスクのタイトル(変更後)"),
				due: z.string().optional().describe("期限日時 (日本時間/JST, 変更後)"),
				priority: z
					.enum(["high", "medium", "low", "none"])
					.optional()
					.describe("緊急度(変更後)"),
				description: z.string().optional().describe("メモ(変更後)"),
			}),
		},
		async ({ listId, uid, summary, due, priority, description }) => {
			try {
				const ics = buildVTODO({ uid, summary, due, priority, description });

				const res = await fetch(`${taskCalendarUrl(env, listId)}${uid}.ics`, {
					method: "PUT",
					headers: {
						Authorization: authHeader(env),
						"Content-Type": "text/calendar; charset=utf-8",
					},
					body: ics,
				});
				if (!res.ok) {
					throw new Error(`更新に失敗: ${res.status} ${await res.text()}`);
				}

				return {
					content: [{ type: "text", text: `タスクを更新した。UID: ${uid}` }],
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
		"complete_task",
		{
			description: "タスクを完了済みにする(他の項目は保持したまま)。",
			inputSchema: z.object({
				listId: z.string().describe("対象リストのid"),
				uid: z.string().describe("完了にするタスクのUID"),
			}),
		},
		async ({ listId, uid }) => {
			try {
				const url = `${taskCalendarUrl(env, listId)}${uid}.ics`;
				const getRes = await fetch(url, {
					method: "GET",
					headers: { Authorization: authHeader(env) },
				});
				if (!getRes.ok) {
					throw new Error(`取得に失敗: ${getRes.status} ${await getRes.text()}`);
				}
				let ics = await getRes.text();
				const now = toICSDate(new Date().toISOString());

				// 既存ICSのSTATUS/PERCENT-COMPLETE/COMPLETED行だけを置換し、
				// DUEやPRIORITY等の他のプロパティは一切いじらない
				if (/STATUS:.*/.test(ics)) {
					ics = ics.replace(/STATUS:.*/, "STATUS:COMPLETED");
				} else {
					ics = ics.replace("END:VTODO", "STATUS:COMPLETED\r\nEND:VTODO");
				}
				if (/PERCENT-COMPLETE:.*/.test(ics)) {
					ics = ics.replace(/PERCENT-COMPLETE:.*/, "PERCENT-COMPLETE:100");
				} else {
					ics = ics.replace("END:VTODO", "PERCENT-COMPLETE:100\r\nEND:VTODO");
				}
				if (/COMPLETED:.*/.test(ics)) {
					ics = ics.replace(/COMPLETED:.*/, `COMPLETED:${now}`);
				} else {
					ics = ics.replace("END:VTODO", `COMPLETED:${now}\r\nEND:VTODO`);
				}

				const putRes = await fetch(url, {
					method: "PUT",
					headers: {
						Authorization: authHeader(env),
						"Content-Type": "text/calendar; charset=utf-8",
					},
					body: ics,
				});
				if (!putRes.ok) {
					throw new Error(`完了処理に失敗: ${putRes.status} ${await putRes.text()}`);
				}

				return {
					content: [{ type: "text", text: `タスクを完了にした。UID: ${uid}` }],
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
});
