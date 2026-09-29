import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Encryption = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
};
const valid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

// Only the trusted renderer can reach this vault. Keys remain with the OS;
// each API origin gets a separate encrypted file, never localStorage.
export class SessionVault {
  readonly filename: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, origin: string, private encryption: Encryption, private platform = process.platform) {
    this.filename = join(directory, `session-${createHash("sha256").update(origin).digest("hex")}.bin`);
  }
  private available(): boolean {
    return this.encryption.isEncryptionAvailable() && (this.platform !== "linux" || this.encryption.getSelectedStorageBackend() !== "basic_text");
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.pending.then(task, task);
    this.pending = next.catch(() => {});
    return next;
  }
  private async write(token: string): Promise<void> {
    const ciphertext = await this.encryption.encryptStringAsync(token);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, ciphertext, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.filename);
    } finally { await rm(temporary, { force: true }); }
  }
  restore(): Promise<{ accessToken: string | null; persistent: boolean }> {
    return this.serial(async () => {
      if (!this.available()) return { accessToken: null, persistent: false };
      try {
        const decrypted = await this.encryption.decryptStringAsync(await readFile(this.filename));
        if (!valid(decrypted.result)) throw new Error("invalid_stored_session");
        if (decrypted.shouldReEncrypt) await this.write(decrypted.result);
        return { accessToken: decrypted.result, persistent: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accessToken: null, persistent: true };
        return { accessToken: null, persistent: false };
      }
    });
  }
  save(token: unknown): Promise<{ persistent: boolean }> {
    return this.serial(async () => {
      if (!valid(token)) throw new Error("invalid_session_token");
      if (!this.available()) return { persistent: false };
      try { await this.write(token); return { persistent: true }; }
      catch { return { persistent: false }; }
    });
  }
  clear(): Promise<void> { return this.serial(() => rm(this.filename, { force: true })); }
}
