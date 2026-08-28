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
	// 入力例: "2026-08-20T10:00:00" → ICS用に "20260820T100000Z" 形式へ
	const d = new Date(dateStr);
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
	const get = (key: string) => {
		const m = ics.match(new RegExp(`${key}:(.*)`));
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

	//calendar tools start

	server.registerTool(
		"list_calendar_events",
		{
			description: "指定期間内のカレンダー予定一覧をNextcloudから取得する。",
			inputSchema: z.object({
				start: z.string().describe("検索開始日時 (ISO8601, 例: 2026-08-01T00:00:00)"),
				end: z.string().describe("検索終了日時 (ISO8601, 例: 2026-08-31T23:59:59)"),
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
				const matches = [...xml.matchAll(/<c:calendar-data>([\s\S]*?)<\/c:calendar-data>/g)];
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
				start: z.string().describe("開始日時 (ISO8601)"),
				end: z.string().describe("終了日時 (ISO8601)"),
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
				start: z.string().describe("開始日時 (ISO8601, 変更後)"),
				end: z.string().describe("終了日時 (ISO8601, 変更後)"),
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
