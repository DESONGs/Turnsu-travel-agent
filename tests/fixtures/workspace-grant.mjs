import { createHash } from "node:crypto";

export async function token(oauth, userId, scopes = ["travel:read", "travel:write"]) {
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const client = await oauth.registerClient({ client_name: "Workspace test", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  const verifier = "travel_test_verifier_abcdefghijklmnopqrstuvwxyz_123456789";
  let location;
  await oauth.authorize(client, { scopes, redirectUri: redirect, codeChallenge: createHash("sha256").update(verifier).digest("base64url"), resource: new URL(oauth.resource), state: "test_state" }, { redirect: value => { location = value; } });
  const pending = new URL(location).searchParams.get("request");
  const callback = await oauth.approve(pending, { userId, displayName: "Traveler", provider: "google" });
  const code = new URL(callback).searchParams.get("code");
  const tokens = await oauth.exchangeAuthorizationCode(client, code, verifier, redirect, new URL(oauth.resource));
  return { ...tokens, client, verifier, code, redirect };
}
