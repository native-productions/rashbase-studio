/**
 * A secret is in the keystore but this build cannot read it, which on macOS
 * means the app's code signature changed since it was saved. The only way
 * forward is to type the password again, so the UI reopens the sheet.
 *
 * Matched as a string against `error.code`; the backend defines the same
 * constant in `src-tauri/src/error.rs`.
 */
export const CREDENTIAL_UNREADABLE = "CREDENTIAL_UNREADABLE";

/**
 * The tunnel stopped for want of a passphrase or a jump-host password: none
 * was stored, the stored one no longer decrypts the key, or the server refused
 * it. All three are fixed by typing it, so the UI reopens the sheet on the SSH
 * field rather than on the database password nobody was asked for.
 *
 * Defined alongside `src-tauri/src/error.rs`.
 */
export const SSH_SECRET_REQUIRED = "SSH_SECRET_REQUIRED";
