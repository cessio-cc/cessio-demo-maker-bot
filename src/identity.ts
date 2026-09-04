import { createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError, type Api, type MakerRegisterCompleteResponse, type MakerRegisterStartResponse } from "./api.ts";

/** The state file. The party key never leaves it; `apiKey` is "" while a registration is in flight. */
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
  /** Ed25519 over the RAW bytes of a base64 hash (sign actions). */
  signHash(hashB64: string): string;
  /** Ed25519 over UTF-8 text (the key-rotation challenge). */
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

/** A corrupt file throws rather than re-registering: a new party would orphan the old one's funds. */
export function loadIdentity(stateFile: string): Identity | undefined {
  if (!existsSync(stateFile)) return undefined;
  return toIdentity(load(stateFile));
}

/** A fresh API key for a party whose key we hold (challenge + rotate); undefined = the desk never knew it. */
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

/** Self-serve registration: generate the party key, sign the topology, persist the identity. */
export async function register(api: Api, displayName: string, stateFile: string): Promise<Identity> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyB64 = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const start = await api.post<MakerRegisterStartResponse>("/maker/register/start", { displayName, publicKey: publicKeyB64 });
  // The key hits the disk before complete: a lost answer is recovered by recoverApiKey.
  save(stateFile, { partyId: start.partyId, hint: "", apiKey: "", privateKeyPem });
  const complete = await api.post<MakerRegisterCompleteResponse>(
    "/maker/register/complete",
    {
      registrationId: start.registrationId,
      signatures: start.topology.map((t) => edSign(null, Buffer.from(t.hash, "base64"), privateKey).toString("base64")),
    },
    60_000,
  );
  const stored = { partyId: complete.partyId, hint: complete.hint, apiKey: complete.apiKey, privateKeyPem };
  save(stateFile, stored);
  return toIdentity(stored);
}
