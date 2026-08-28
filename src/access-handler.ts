import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
	decodeIdTokenPayload,
	fetchUpstreamAuthToken,
	generateStateToken,
	getUpstreamAuthorizeUrl,
	type Props,
} from "./access-oauth-utils";

type Env = {
	ACCESS_CLIENT_ID: string;
	ACCESS_CLIENT_SECRET: string;
	ACCESS_TOKEN_URL: string;
	ACCESS_AUTHORIZATION_URL: string;
	// Access for SaaSに登録済みのメールアドレス(任意の追加チェックに使いたい場合)
	ALLOWED_EMAIL?: string;
	OAUTH_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

/**
 * Claude(MCPクライアント)からの認可リクエストを受け取り、
 * Cloudflare Accessのログイン画面にリダイレクトする。
 */
app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	if (!oauthReqInfo.clientId) {
		return c.text("Invalid request", 400);
	}

	// このMCPサーバ用のstateトークンを発行し、
	// 元のoauthReqInfoと紐付けてKVに一時保存する（5分で失効）
	const stateToken = generateStateToken();
	await c.env.OAUTH_KV.put(`state:${stateToken}`, JSON.stringify(oauthReqInfo), {
		expirationTtl: 300,
	});

	const redirectUrl = getUpstreamAuthorizeUrl({
		upstream_url: c.env.ACCESS_AUTHORIZATION_URL,
		client_id: c.env.ACCESS_CLIENT_ID,
		redirect_uri: new URL("/callback", c.req.url).href,
		scope: "openid email profile",
		state: stateToken,
	});

	return Response.redirect(redirectUrl, 302);
});

/**
 * Cloudflare Accessでのログイン完了後に呼ばれるコールバック。
 * 認可コードをアクセストークンに交換し、Claude側に処理を返す。
 */
app.get("/callback", async (c) => {
	const stateToken = c.req.query("state");
	if (!stateToken) {
		return c.text("Missing state", 400);
	}

	const storedRaw = await c.env.OAUTH_KV.get(`state:${stateToken}`);
	if (!storedRaw) {
		return c.text("Invalid or expired state (retry connecting from Claude)", 400);
	}
	await c.env.OAUTH_KV.delete(`state:${stateToken}`);
	const oauthReqInfo = JSON.parse(storedRaw);

	const [tokens, errResponse] = await fetchUpstreamAuthToken({
		upstream_url: c.env.ACCESS_TOKEN_URL,
		client_id: c.env.ACCESS_CLIENT_ID,
		client_secret: c.env.ACCESS_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
	});
	if (errResponse) return errResponse;
	if (!tokens) return c.text("Token exchange failed", 500);

	const { email, sub } = decodeIdTokenPayload(tokens.id_token);

	// (任意) 特定のメールアドレスだけに絞りたい場合のチェック
	if (c.env.ALLOWED_EMAIL && email !== c.env.ALLOWED_EMAIL) {
		return c.text(`Access denied for ${email}`, 403);
	}

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: email },
		props: {
			email,
			sub,
			accessToken: tokens.access_token,
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: sub,
	});

	return Response.redirect(redirectTo, 302);
});

export { app as AccessHandler };
