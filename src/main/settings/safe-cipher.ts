import { safeStorage } from "electron";
import type { Cipher } from "./provider-store";

/**
 * Encrypts API keys with the OS credential store (DPAPI on Windows: only this Windows user, on
 * this machine, can decrypt). Kept apart from provider-store.ts so that file has no Electron
 * import and can be unit-tested.
 */
export const safeStorageCipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
  decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
};
