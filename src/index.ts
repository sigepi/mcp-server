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
async function putNoteToWrapper(env: Env, repoPath: string, content: string): Promise<void> {
	const p = toWrapperPath(repoPath);
	const res = await wrapperFetch(env, `/file?path=${encodeURIComponent(p)}`, {
		method: "PUT",
		body: content,
	});
	if (!res.ok) throw new Error(`書き込みに失敗 (${res.status}): ${await res.text()}`);
}

/** ノートを削除する */
async function deleteNoteFromWrapper(env: Env, repoPath: string): Promise<void> {
	const p = toWrapperPath(repoPath);
	const res = await wrapperFetch(env, `/file?path=${encodeURIComponent(p)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`削除に失敗 (${res.status}): ${await res.text()}`);
}

/** Vault内の.mdファイルパス一覧を取得する(search_notes用) */
async function listVaultMarkdownPaths(env: Env, prefix = ""): Promise<string[]> {
	const p = toWrapperPath(prefix);
	const res = await wrapperFetch(env, `/list?prefix=${encodeURIComponent(p)}`);
	if (!res.ok) throw new Error(`ファイル一覧の取得に失敗 (${res.status}): ${await res.text()}`);
	const data = (await res.json()) as { files: string[] };
	return data.files.filter((f) => f.endsWith(".md")).map(fromWrapperPath);
}

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
				await putNoteToWrapper(env, path, content);
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
				await putNoteToWrapper(env, path, newContent);
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
				await putNoteToWrapper(env, path, content);
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
				"Obsidian Vault内の既存ノートを削除する。ノートが存在しない場合はエラーになる。削除は取り消せないので、確実に消したいノートのpathを指定すること。",
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
				await deleteNoteFromWrapper(env, path);
				return {
					content: [{ type: "text", text: `削除した: ${path}` }],
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
