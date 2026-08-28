/**
 * Cloudflare Access (Access for SaaS / OIDC) との間で行う
 * OAuth 2.0 認可コードフローのための小さなヘルパー群。
 *
 * 参考: Cloudflare公式の remote-mcp-github-oauth デモの
 * utils.ts / github-handler.ts の構成を、GitHubではなく
 * Cloudflare Access (OIDC) 向けに簡略化して書き換えたもの。
 */

export type Props = {
	email: string;
	sub: string; // Access側のユーザー識別子 (id_tokenのsubクレーム)
	accessToken: string;
};

/**
 * Access の authorization endpoint への遷移URLを組み立てる。
 */
export function getUpstreamAuthorizeUrl(opts: {
	upstream_url: string; // ACCESS_AUTHORIZATION_URL
	client_id: string;
	redirect_uri: string;
	scope: string;
	state: string;
}): string {
	const url = new URL(opts.upstream_url);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", opts.client_id);
	url.searchParams.set("redirect_uri", opts.redirect_uri);
	url.searchParams.set("scope", opts.scope);
	url.searchParams.set("state", opts.state);
	return url.toString();
}

/**
 * 認可コードをAccessのtoken endpointに送ってトークンに交換する。
 * 成功時は [tokens, null]、失敗時は [null, Response] を返す。
 */
export async function fetchUpstreamAuthToken(opts: {
	upstream_url: string; // ACCESS_TOKEN_URL
	client_id: string;
	client_secret: string;
	code: string | undefined;
	redirect_uri: string;
}): Promise<[{ access_token: string; id_token: string } | null, Response | null]> {
	if (!opts.code) {
		return [null, new Response("Missing authorization code", { status: 400 })];
	}

	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: opts.client_id,
		client_secret: opts.client_secret,
		code: opts.code,
		redirect_uri: opts.redirect_uri,
	});

	const resp = await fetch(opts.upstream_url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!resp.ok) {
		const text = await resp.text();
		return [null, new Response(`Failed to exchange token: ${text}`, { status: 500 })];
	}

	const json = (await resp.json()) as { access_token: string; id_token: string };
	return [json, null];
}

/**
 * id_token (JWT) のペイロードだけを取り出す簡易デコード。
 * Access -> このWorker間はHTTPS+client_secretで完結する
 * サーバー間通信なので、ここでは署名検証までは行っていない。
 * より厳格にしたい場合は ACCESS_JWKS_URL を使って署名検証を追加する。
 */
export function decodeIdTokenPayload(idToken: string): { email: string; sub: string } {
	const payloadPart = idToken.split(".")[1];
	const json = atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
	const payload = JSON.parse(json);
	return { email: payload.email, sub: payload.sub };
}

/** ランダムなstateトークンを生成する */
export function generateStateToken(): string {
	return crypto.randomUUID();
}
