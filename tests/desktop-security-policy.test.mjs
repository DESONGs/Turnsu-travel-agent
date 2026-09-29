import assert from "node:assert/strict";
import test from "node:test";
import {
  evidencePlatform,
  isAllowedEvidenceUrl,
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  oauthStartUrl,
  parseDesktopAuthCallback,
} from "../apps/desktop/src/security-policy.ts";

test("desktop evidence view reuses the fixed social host policy and blocks arbitrary navigation", () => {
  assert.equal(evidencePlatform("https://www.xiaohongshu.com/explore/abc"), "xiaohongshu");
  assert.equal(evidencePlatform("https://mp.weixin.qq.com/s/abc"), "wechat");
  assert.equal(isAllowedEvidenceUrl("https://www.douyin.com/video/abc", "douyin"), true);
  assert.equal(isAllowedEvidenceUrl("https://www.douyin.com/video/abc", "xiaohongshu"), false);
  assert.equal(isAllowedEvidenceUrl("http://www.douyin.com/video/abc"), false);
  assert.equal(isAllowedEvidenceUrl("https://127.0.0.1/internal"), false);
});

test("desktop OAuth opens only a fixed provider path and returns a one-time code shape", () => {
  const start = new URL(oauthStartUrl("https://travel.example.com", "google", "/trip/1"));
  assert.equal(start.origin, "https://travel.example.com");
  assert.equal(start.pathname, "/api/auth/google/start");
  assert.equal(start.searchParams.get("client"), "desktop");
  assert.equal(oauthStartUrl("https://travel.example.com", "unknown", "/"), null);
  const link = "a".repeat(43);
  assert.equal(new URL(oauthStartUrl("https://travel.example.com", "wechat", "/?account=connections", link)).searchParams.get("link"), link);
  assert.equal(oauthStartUrl("https://travel.example.com", "wechat", "/", "bad-link"), null);
  const callback = parseDesktopAuthCallback("zhuanshu-travel://auth/callback?code=single-use&returnTo=%2Ftrip%2F1");
  assert.deepEqual(callback, { code: "single-use", returnTo: "/trip/1" });
  assert.equal(parseDesktopAuthCallback("zhuanshu-travel://auth/callback?code=one&auth_error=two"), null);
  assert.equal(parseDesktopAuthCallback("https://evil.example/callback?code=one"), null);
});

test("trusted renderer and system browser destinations are explicit allowlists", () => {
  assert.equal(isTrustedRendererUrl("travelapp://app/index.html"), true);
  assert.equal(isTrustedRendererUrl("https://evil.example"), false);
  assert.equal(isAllowedExternalUrl("https://uri.amap.com/navigation?to=1,2"), true);
  assert.equal(isAllowedExternalUrl("https://www.fliggy.com/booking"), true);
  assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedExternalUrl("https://example.com"), false);
});
