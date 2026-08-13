import { createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  HttpError,
  type Api,
  type MakerRegisterCompleteResponse,
  type MakerRegisterStartResponse,
  type SignActionDto,
} from "./api.ts";

/** What survives restarts. The party key never leaves this file. `apiKey` (and
 * `hint`) are "" while a registration is in flight — the key is persisted
 * BEFORE register/complete, so a lost complete answer costs nothing the
 * challenge + rotate recovery cannot get back. */
interface StoredIdentity {
  partyId: string;
  hint: string;
  apiKey: string;
  privateKeyPem: string;
}

export interface Identity {
  partyId: string;
  hint: string;
  apiKey: string;
  /** base64 Ed25519 signature over the RAW bytes of a base64 hash (openapi:
   * sign the bytes, never the base64 text). */
  signHash(hashB64: string): string;
  /** base64 Ed25519 signature over a challenge as UTF-8 text (rotate path). */
  signText(text: string): string;
}

function toIdentity(stored: StoredIdentity): Identity {
  const privateKey: KeyObject = createPrivateKey(stored.privateKeyPem);
  return {
    partyId: stored.partyId,
    hint: stored.hint,
    apiKey: stored.apiKey,
    signHash: (hashB64) => edSign(null, Buffer.from(hashB64, "base64"), privateKey).toString("base64"),
    signText: (text) => edSign(null, Buffer.from(text, "utf8"), privateKey).toString("base64"),
  };
}

function save(stateFile: string, stored: StoredIdentity): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
}

function load(stateFile: string): StoredIdentity {
  return JSON.parse(readFileSync(stateFile, "utf8")) as StoredIdentity;
}

/** A corrupt state file throws instead of silently re-registering: a fresh
 * registration would orphan the previous party together with its funds. */
export function loadIdentity(stateFile: string): Identity | undefined {
  if (!existsSync(stateFile)) return undefined;
  return toIdentity(load(stateFile));
}

/** Recovery for a half-finished registration (key on disk, apiKey "") — the
 * register/complete answer was lost after the desk may have committed it.
 * Proves key ownership via challenge + rotate and gets a fresh key. Returns
 * undefined when the desk never knew the party (complete never landed): the
 * caller registers afresh, orphaning only an unfinished party id. */
export async function recoverApiKey(api: Api, stateFile: string): Promise<Identity | undefined> {
  const stored = load(stateFile);
  const idn = toIdentity(stored);
  try {
    const { challenge } = await api.post<{ challenge: string }>("/maker/challenge", { partyId: stored.partyId });
    const { apiKey } = await api.post<{ apiKey: string }>("/maker/api-key/rotate", {
      partyId: stored.partyId,
      challenge,
      signature: idn.signText(challenge),
    });
    save(stateFile, { ...stored, apiKey });
    return toIdentity({ ...stored, apiKey });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return undefined;
    throw e;
  }
}

/** Self-serve registration (openapi /maker/register/*): generate the party
 * key, sign the topology hashes, persist the identity, and hand back the
 * settlement-service activation actions for the caller to sign. */
export async function register(
  api: Api,
  displayName: string,
  stateFile: string,
): Promise<{ identity: Identity; actions: SignActionDto[] }> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyB64 = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const start = await api.post<MakerRegisterStartResponse>("/maker/register/start", {
    displayName,
    publicKey: publicKeyB64,
  });
  // Key hits the disk before complete — see StoredIdentity.
  save(stateFile, { partyId: start.partyId, hint: "", apiKey: "", privateKeyPem });
  const complete = await api.post<MakerRegisterCompleteResponse>(
    "/maker/register/complete",
    {
      registrationId: start.registrationId,
      signatures: start.topology.map((t) => edSign(null, Buffer.from(t.hash, "base64"), privateKey).toString("base64")),
    },
    60_000, // party allocation + topology on a live network is slow
  );

  const stored: StoredIdentity = { partyId: complete.partyId, hint: complete.hint, apiKey: complete.apiKey, privateKeyPem };
  save(stateFile, stored);
  return { identity: toIdentity(stored), actions: complete.actions };
}
