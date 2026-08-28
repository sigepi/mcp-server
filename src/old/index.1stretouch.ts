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
};

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
	return atob(base64);
}

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
