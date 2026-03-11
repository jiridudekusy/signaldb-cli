/**
 * Utility script that extracts the SQLCipher key used by Signal Desktop.
 *
 * On older installs Signal may expose the key directly in `config.json`.
 * On newer installs the key is wrapped by Chromium OSCrypt, so this script:
 * - reads Signal's `config.json`
 * - fetches the "Signal Safe Storage" secret from macOS Keychain
 * - derives the AES key using Chromium's legacy PBKDF2 settings
 * - decrypts the stored `encryptedKey` and prints the plaintext key
 *
 * The output can be copied into `SIGNAL_DECRYPTION_KEY`.
 */

const crypto = require("crypto");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Allow overriding the Signal folder for troubleshooting or non-default installs.
const signalDir =
  process.env.SIGNAL_DIR ||
  path.join(os.homedir(), "Library", "Application Support", "Signal");
const configPath = path.join(signalDir, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Some Signal versions still store the raw key directly.
if (config.key) {
  console.log(config.key);
  process.exit(0);
}

if (!config.encryptedKey) {
  console.error("No encryptedKey or key found in config.json");
  process.exit(1);
}

// Signal stores encryptedKey as a hex string (not base64)
const encryptedBuf = Buffer.from(config.encryptedKey, "hex");
const prefix = encryptedBuf.slice(0, 3).toString("ascii");

// Chromium prefixes encrypted blobs with the ASCII version marker `v10`.
if (prefix !== "v10") {
  console.error(`Unexpected prefix: "${prefix}" (expected "v10")`);
  process.exit(1);
}

// Read the safe-storage password from macOS Keychain
const keychainPassword = execSync(
  'security find-generic-password -s "Signal Safe Storage" -w',
  { encoding: "utf8" }
).trim();

// Chromium OSCrypt parameters used by Electron/Chrome on macOS for legacy blobs.
const derivedKey = crypto.pbkdf2Sync(
  keychainPassword, "saltysalt", 1003, 16, "sha1"
);

// AES-128-CBC, IV = 16 bytes of 0x20 (space)
const iv = Buffer.alloc(16, 0x20);
const ciphertext = encryptedBuf.slice(3);

const decipher = crypto.createDecipheriv("aes-128-cbc", derivedKey, iv);
const plaintext = Buffer.concat([
  decipher.update(ciphertext),
  decipher.final(),
]);

console.log(plaintext.toString("utf8"));
