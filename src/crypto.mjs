import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAGIC = Buffer.from("FAM1");

function powershell(script, env, input) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ${script}`], {
    env: { ...process.env, ...env }, input, encoding: "utf8", windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  }).trim();
}

export function loadKey(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const secretPath = join(dataDir, "key.dpapi");
  let encoded;
  if (existsSync(secretPath)) {
    encoded = powershell(
      "$bytes=[Convert]::FromBase64String((Get-Content -Raw -LiteralPath $env:FAMILY_SECRET_PATH).Trim()); $plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($plain)",
      { FAMILY_SECRET_PATH: secretPath }
    );
  } else {
    encoded = randomBytes(32).toString("base64");
    powershell(
      "$value=[Console]::In.ReadToEnd().Trim(); $bytes=[Convert]::FromBase64String($value); $sealed=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllText($env:FAMILY_SECRET_PATH,[Convert]::ToBase64String($sealed))",
      { FAMILY_SECRET_PATH: secretPath }, encoded
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("Ugyldig arkivnøkkel.");
  return key;
}

export function encrypt(bytes, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), payload]);
}

export function decrypt(bytes, key) {
  if (!bytes.subarray(0, 4).equals(MAGIC) || bytes.length < 32) throw new Error("Ukjent arkivformat.");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(4, 16));
  decipher.setAuthTag(bytes.subarray(16, 32));
  return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
}

export function readEncrypted(path, key) { return decrypt(readFileSync(path), key); }
export function writeEncrypted(path, bytes, key) { writeFileSync(path, encrypt(bytes, key)); }
