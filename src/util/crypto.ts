import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";
const SALT = "anyway2codex-v1";

function deriveKey(password: string): Buffer {
  return scryptSync(password, SALT, 32);
}

export function encrypt(plaintext: string, password: string) {
  const key = deriveKey(password);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt(ciphertext: string, iv: string, tag: string, password: string): string {
  const key = deriveKey(password);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
