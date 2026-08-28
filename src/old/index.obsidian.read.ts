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

//calendar helpers start
const CALDAV_BASE = "https://fie.nl.tab.digital/remote.php/dav/calendars";

function calendarUrl(env: Env): string {
	return `${CALDAV_BASE}/${env.NEXTCLOUD_USERNAME}/personal/`;
}

function authHeader(env: Env): string {
	const raw = `${env.NEXTCLOUD_USERNAME}:${env.NEXTCLOUD_APP_PASSWORD}`;
	return "Basic " + btoa(raw);
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
