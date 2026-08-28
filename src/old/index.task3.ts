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
	// GitHub経由でObsidian Vault(private repo)を読み書きするための設定
	GITHUB_TOKEN: string;
	GITHUB_OWNER: string;
	GITHUB_REPO: string;
	// Nextcloud CalDAV連携用
	NEXTCLOUD_USERNAME: string;
	NEXTCLOUD_APP_PASSWORD: string;
	// Nextcloud WebDAV連携用
	NEXTCLOUD_WEBDAV_PASSWORD: string;
};

//note read start?

/**
 * GitHub Contents APIで指定パスのファイルを1本取得する。
 * private repoでも GITHUB_TOKEN (fine-grained PAT, Contents権限) があれば読める。
 */
async function fetchNoteFromGitHub(env: Env, path: string): Promise<string> {
	const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"User-Agent": "obsidian-mcp-server",
			Accept: "application/vnd.github.v3+json",
		},
	});

	if (res.status === 404) {
		throw new Error(`ノートが見つからへんかった: ${path}`);
	}
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub APIエラー (${res.status}): ${text}`);
	}

	const data = (await res.json()) as { content: string; encoding: string };
	if (data.encoding !== "base64") {
		throw new Error(`想定外のencoding: ${data.encoding}`);
	}

	// GitHub APIのbase64は改行区切りで返ってくるので除去してからデコード
	const base64 = data.content.replace(/\n/g, "");
	const binary = atob(base64);
	// atob()は1バイト=1文字として返すため、UTF-8のマルチバイト文字(日本語等)が
	// そのままだと文字化けする。バイト列に変換してからUTF-8として正しくデコードする。
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder("utf-8").decode(bytes);
}
//note read end ?

//note search start

/**
 * リポジトリのデフォルトブランチ名を取得する(main / master どちらでも対応するため)。
 */
async function fetchDefaultBranch(env: Env): Promise<string> {
	const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"User-Agent": "obsidian-mcp-server",
			Accept: "application/vnd.github.v3+json",
		},
	});
	if (!res.ok) {
		throw new Error(`リポジトリ情報の取得に失敗 (${res.status}): ${await res.text()}`);
	}
	const data = (await res.json()) as { default_branch: string };
	return data.default_branch;
}

/**
 * GitHub Git Trees API(recursive)でVault内の.mdファイルパス一覧を丸ごと取得する。
 * Vaultが極端に巨大(数万ファイル)だとGitHub側がtruncated:trueを返すことがあるが、
 * 個人のObsidian Vault規模なら通常は全件取れる。
 */
async function fetchVaultMarkdownPaths(env: Env): Promise<string[]> {
	const branch = await fetchDefaultBranch(env);
	const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/trees/${branch}?recursive=1`;

	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"User-Agent": "obsidian-mcp-server",
			Accept: "application/vnd.github.v3+json",
		},
	});
	if (!res.ok) {
		throw new Error(`ファイル一覧の取得に失敗 (${res.status}): ${await res.text()}`);
	}

	const data = (await res.json()) as {
		tree: { path: string; type: string }[];
		truncated?: boolean;
	};

	return data.tree
		.filter((item) => item.type === "blob" && item.path.endsWith(".md"))
		.map((item) => item.path);
}

/**
 * マッチ箇所の前後を切り出してスニペットを作る(本文全文検索用)。
 */
function makeSnippet(content: string, query: string, contextChars = 40): string {
	const idx = content.toLowerCase().indexOf(query.toLowerCase());
	if (idx === -1) return "";
	const start = Math.max(0, idx - contextChars);
	const end = Math.min(content.length, idx + query.length + contextChars);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < content.length ? "…" : "";
	return prefix + content.slice(start, end).replace(/\n/g, " ") + suffix;
}

//note search end

//note write start

/**
 * UTF-8文字列(日本語含む)をGitHub Contents APIが要求するbase64に変換する。
 */
function toBase64Utf8(str: string): string {
	const bytes = new TextEncoder().encode(str);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/**
 * ノートの現在の中身とSHAをまとめて取得する。存在しない場合はnullを返す(例外にしない)。
 * SHAは追記/上書き更新時にGitHub APIへ渡す競合検知用の値。
 */
async function fetchNoteMeta(
	env: Env,
	path: string,
): Promise<{ content: string; sha: string } | null> {
	const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"User-Agent": "obsidian-mcp-server",
			Accept: "application/vnd.github.v3+json",
		},
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`ノート情報の取得に失敗 (${res.status}): ${await res.text()}`);
	}
	const data = (await res.json()) as { content: string; encoding: string; sha: string };
	if (data.encoding !== "base64") {
		throw new Error(`想定外のencoding: ${data.encoding}`);
	}
	const base64 = data.content.replace(/\n/g, "");
	const binary = atob(base64);
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return { content: new TextDecoder("utf-8").decode(bytes), sha: data.sha };
}

/**
 * GitHub Contents APIでノートを作成/更新する(自動コミット)。
 * shaを渡すと更新、渡さないと新規作成として扱われる。
 */
async function putNoteToGitHub(
	env: Env,
	path: string,
	content: string,
	sha?: string,
	message?: string,
): Promise<{ html_url: string }> {
	const branch = await fetchDefaultBranch(env);
	const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

	const body: Record<string, unknown> = {
		message: message ?? (sha ? `Update ${path} via Obsidian MCP` : `Create ${path} via Obsidian MCP`),
		content: toBase64Utf8(content),
		branch,
	};
	if (sha) body.sha = sha;

	const res = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"User-Agent": "obsidian-mcp-server",
			Accept: "application/vnd.github.v3+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text();
		if (res.status === 403 || res.status === 401) {
			throw new Error(
				`書き込みに失敗 (${res.status}): GITHUB_TOKENの権限を確認して(Contents権限がRead and writeになってるか)。詳細: ${text}`,
			);
		}
		if (res.status === 409) {
			throw new Error(
				`書き込みに失敗 (409): 他の変更と競合した可能性がある。もう一度読み直してから再実行して。詳細: ${text}`,
			);
		}
		throw new Error(`書き込みに失敗 (${res.status}): ${text}`);
	}

	const data = (await res.json()) as { content: { html_url: string } };
	return { html_url: data.content.html_url };
}

/**
 * GitHub Contents APIでノートを削除する(自動コミット)。SHAが必須。
 */
async function deleteNoteFromGitHub(
	env: Env,
	path: string,
	sha: string,
	message?: string,
): Promise<void> {
	const branch = await fetchDefaultBranch(env);
	const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

	const res = await fetch(url, {
		method: "DELETE",
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"User-Agent": "obsidian-mcp-server",
			Accept: "application/vnd.github.v3+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			message: message ?? `Delete ${path} via Obsidian MCP`,
			sha,
			branch,
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		if (res.status === 403 || res.status === 401) {
			throw new Error(
				`削除に失敗 (${res.status}): GITHUB_TOKENの権限を確認して(Contents権限がRead and writeになってるか)。詳細: ${text}`,
			);
		}
		throw new Error(`削除に失敗 (${res.status}): ${text}`);
	}
}

//note write end

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

// 個別タスクリストのURL。idはlist_calendarsで取得したhref末尾の部分。
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
 * list_calendars と list_tasks(listId省略時) の両方から使う。
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
async function readFile(path, env) {
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
async function uploadFile(path, content, env) {
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
async function deleteFile(path, env) {
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
async function createFolder(path, env) {
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
async function listFiles(path, env) {
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

function parseWebDavResponse(xml) {
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
				"Obsidian Vault内の指定パスのノート(Markdownファイル)を1本読み込む。pathはリポジトリルートからの相対パス(例: 'daily/2026-08-12.md')。",
			inputSchema: z.object({
				path: z.string().describe("リポジトリルートからの相対パス"),
			}),
		},
		async ({ path }) => {
			try {
				const content = await fetchNoteFromGitHub(env, path);
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
				const paths = await fetchVaultMarkdownPaths(env);
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
				"Obsidian Vault内のノートの本文中身を全文検索する。ヒットしたファイルのパスと前後の抜粋(スニペット)を返す。Vaultが大きい場合は処理するファイル数に上限があるため、path_prefixでフォルダを絞り込むと確実性が上がる。",
			inputSchema: z.object({
				query: z.string().describe("本文中で探すキーワード"),
				path_prefix: z
					.string()
					.optional()
					.describe("この文字列で始まるパスのファイルだけを対象にする(例: 'daily/')"),
				max_files_to_scan: z
					.number()
					.optional()
					.describe("最大何ファイルまで中身を確認するか(デフォルト100、多いとGitHub APIコール数が増える)"),
				max_results: z
					.number()
					.optional()
					.describe("最大何件のヒットを返すか(デフォルト20)"),
			}),
		},
		async ({ query, path_prefix, max_files_to_scan, max_results }) => {
			try {
				let paths = await fetchVaultMarkdownPaths(env);
				if (path_prefix) {
					paths = paths.filter((p) => p.startsWith(path_prefix));
				}

				const scanLimit = max_files_to_scan ?? 100;
				const resultLimit = max_results ?? 20;
				const targetPaths = paths.slice(0, scanLimit);

				const results: { path: string; snippet: string }[] = [];
				let scanned = 0;

				for (const path of targetPaths) {
					scanned++;
					const content = await fetchNoteFromGitHub(env, path);
					if (content.toLowerCase().includes(query.toLowerCase())) {
						results.push({ path, snippet: makeSnippet(content, query) });
						if (results.length >= resultLimit) break;
					}
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									total_candidate_files: paths.length,
									scanned_files: scanned,
									hit_count: results.length,
									note:
										scanned < paths.length
											? `候補${paths.length}件中${scanned}件しかスキャンしてへん。path_prefixで絞るか max_files_to_scan を増やすともっと網羅できる。`
											: undefined,
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
				message: z.string().optional().describe("コミットメッセージ(省略時は自動生成)"),
			}),
		},
		async ({ path, content, message }) => {
			try {
				const existing = await fetchNoteMeta(env, path);
				if (existing) {
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
				const result = await putNoteToGitHub(env, path, content, undefined, message);
				return {
					content: [{ type: "text", text: `作成した: ${path}\n${result.html_url}` }],
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
				message: z.string().optional().describe("コミットメッセージ(省略時は自動生成)"),
			}),
		},
		async ({ path, content, separator, message }) => {
			try {
				const existing = await fetchNoteMeta(env, path);
				if (!existing) {
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
				const newContent = existing.content + (separator ?? "\n") + content;
				const result = await putNoteToGitHub(env, path, newContent, existing.sha, message);
				return {
					content: [{ type: "text", text: `追記した: ${path}\n${result.html_url}` }],
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
				message: z.string().optional().describe("コミットメッセージ(省略時は自動生成)"),
			}),
		},
		async ({ path, content, message }) => {
			try {
				const existing = await fetchNoteMeta(env, path);
				if (!existing) {
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
				const result = await putNoteToGitHub(env, path, content, existing.sha, message);
				return {
					content: [{ type: "text", text: `更新した: ${path}\n${result.html_url}` }],
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
				message: z.string().optional().describe("コミットメッセージ(省略時は自動生成)"),
			}),
		},
		async ({ path, message }) => {
			try {
				const existing = await fetchNoteMeta(env, path);
				if (!existing) {
					return {
						content: [
							{ type: "text", text: `エラー: ${path} が見つからへん。既に削除済みかパス間違いかも。` },
						],
						isError: true,
					};
				}
				await deleteNoteFromGitHub(env, path, existing.sha, message);
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
		"list_calendars",
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
				const body = `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>${escapeXml(displayname)}</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VTODO"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>`;

				const res = await fetch(`${calendarsBaseUrl(env)}${id}/`, {
					method: "MKCALENDAR",
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
			description: "既存タスクリストの表示名を変更する。idはlist_calendarsで取得したものを使う。",
			inputSchema: z.object({
				id: z.string().describe("対象リストのid (list_calendarsのidフィールド)"),
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
				id: z.string().describe("削除対象リストのid (list_calendarsのidフィールド)"),
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
					.describe("対象リストのid (list_calendarsのidフィールド)。省略時は全リスト"),
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
				listId: z.string().describe("作成先リストのid (list_calendarsのidフィールド)"),
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
 * ツール内で確実にGITHUB_TOKEN等のSecretsにアクセスできるようにしている。
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
