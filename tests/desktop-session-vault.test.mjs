import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionVault } from "../apps/desktop/src/session-vault.ts";

test("desktop vault persists encrypted sessions across instances, separates origins, and clears after queued saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "travel-vault-"));
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptStringAsync: async (value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptStringAsync: async (bytes) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"), shouldReEncrypt: false };
    },
  };
  try {
    const first = new SessionVault(directory, "https://travel.example.com", encryption);
    const token = randomBytes(32).toString("base64url");
    assert.equal((await first.save(token)).persistent, true);
    assert.equal((await readFile(first.filename)).includes(token), false);
    const restored = new SessionVault(directory, "https://travel.example.com", encryption);
    assert.equal((await restored.restore()).accessToken, token);
    const otherOrigin = new SessionVault(directory, "https://other.example.com", encryption);
    assert.equal((await otherOrigin.restore()).accessToken, null);
    await Promise.all([restored.save(randomBytes(32).toString("base64url")), restored.clear()]);
    assert.equal((await first.restore()).accessToken, null);
    assert.deepEqual(await readdir(directory), []);
    const insecure = new SessionVault(directory, "https://travel.example.com", { ...encryption, getSelectedStorageBackend: () => "basic_text" }, "linux");
    assert.equal((await insecure.save(token)).persistent, false);
    assert.equal((await insecure.restore()).persistent, false);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(first.save("unexpected-input"), /invalid_session_token/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
