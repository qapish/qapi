// ESM sub-imports with `.js` per noble-post-quantum README
import { ml_dsa44, ml_dsa65, ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import {
  ml_kem512,
  ml_kem768,
  ml_kem1024,
} from "@noble/post-quantum/ml-kem.js";

export type Bytes = Uint8Array;

// Accept both hyphenated and underscore variants for ergonomics
export type MlDsaVariant =
  | "ml-dsa-44"
  | "ml-dsa44"
  | "ml-dsa-65"
  | "ml-dsa65"
  | "ml-dsa-87"
  | "ml-dsa87";
export type MlKemVariant =
  | "ml-kem-512"
  | "ml_kem512"
  | "ml-kem-768"
  | "ml_kem768"
  | "ml-kem-1024"
  | "ml_kem1024";

export interface SignerConfig {
  scheme: "ml-dsa";
  variant?: MlDsaVariant;
}
export interface KemConfig {
  scheme: "ml-kem";
  variant?: MlKemVariant;
}

export interface KeyPair {
  publicKey: Bytes;
  secretKey: Bytes;
}
export interface KemKeyPair {
  publicKey: Bytes;
  secretKey: Bytes;
}
export interface KemCiphertext {
  ciphertext: Bytes;
  sharedSecret: Bytes;
}

// ---- ML-DSA (signatures) ----

type MlDsaImpl = {
  keyPair: () => { publicKey: Bytes; secretKey: Bytes };
  sign: (message: Bytes, secretKey: Bytes) => Bytes | Promise<Bytes>;
  verify: (
    sig: Bytes,
    message: Bytes,
    publicKey: Bytes,
  ) => boolean | Promise<boolean>;
};

function selectMlDsa(variant: MlDsaVariant | undefined): MlDsaImpl {
  const v = (variant ?? "ml-dsa-65").replace("_", "-");
  switch (v) {
    case "ml-dsa-44":
      return ml_dsa44 as unknown as MlDsaImpl;
    case "ml-dsa-65":
      return ml_dsa65 as unknown as MlDsaImpl;
    case "ml-dsa-87":
      return ml_dsa87 as unknown as MlDsaImpl;
    default:
      throw new Error(`Unsupported ML-DSA variant: ${String(variant)}`);
  }
}

export function keygen(
  cfg: SignerConfig = { scheme: "ml-dsa", variant: "ml-dsa-65" },
): KeyPair {
  const impl = selectMlDsa(cfg.variant);
  return impl.keyPair();
}

export async function sign(
  message: Bytes,
  secretKey: Bytes,
  cfg: SignerConfig = { scheme: "ml-dsa", variant: "ml-dsa-65" },
): Promise<Bytes> {
  const impl = selectMlDsa(cfg.variant);
  return await impl.sign(message, secretKey);
}

export async function verify(
  signature: Bytes,
  message: Bytes,
  publicKey: Bytes,
  cfg: SignerConfig = { scheme: "ml-dsa", variant: "ml-dsa-65" },
): Promise<boolean> {
  const impl = selectMlDsa(cfg.variant);
  return await impl.verify(signature, message, publicKey);
}

export function createSigner(
  cfg: SignerConfig = { scheme: "ml-dsa", variant: "ml-dsa-65" },
) {
  const impl = selectMlDsa(cfg.variant);
  return {
    keygen: (): KeyPair => impl.keyPair(),
    sign: (msg: Bytes, sk: Bytes) => impl.sign(msg, sk),
    verify: (sig: Bytes, msg: Bytes, pk: Bytes) => impl.verify(sig, msg, pk),
    variant: (cfg.variant ?? "ml-dsa-65") as MlDsaVariant,
  };
}

// ---- ML-KEM (Kyber-style KEM) ----

type MlKemImpl = {
  keyPair: () => { publicKey: Bytes; secretKey: Bytes };
  encapsulate: (
    publicKey: Bytes,
  ) =>
    | { ciphertext: Bytes; sharedSecret: Bytes }
    | Promise<{ ciphertext: Bytes; sharedSecret: Bytes }>;
  decapsulate: (ciphertext: Bytes, secretKey: Bytes) => Bytes | Promise<Bytes>;
};

function selectMlKem(variant: MlKemVariant | undefined): MlKemImpl {
  const v = (variant ?? "ml-kem-768").replace("_", "-");
  switch (v) {
    case "ml-kem-512":
      return ml_kem512 as unknown as MlKemImpl;
    case "ml-kem-768":
      return ml_kem768 as unknown as MlKemImpl;
    case "ml-kem-1024":
      return ml_kem1024 as unknown as MlKemImpl;
    default:
      throw new Error(`Unsupported ML-KEM variant: ${String(variant)}`);
  }
}

export function kemKeygen(
  cfg: KemConfig = { scheme: "ml-kem", variant: "ml-kem-768" },
): KemKeyPair {
  const impl = selectMlKem(cfg.variant);
  return impl.keyPair();
}

export async function encapsulate(
  publicKey: Bytes,
  cfg: KemConfig = { scheme: "ml-kem", variant: "ml-kem-768" },
): Promise<KemCiphertext> {
  const impl = selectMlKem(cfg.variant);
  return (await impl.encapsulate(publicKey)) as KemCiphertext;
}

export async function decapsulate(
  ciphertext: Bytes,
  secretKey: Bytes,
  cfg: KemConfig = { scheme: "ml-kem", variant: "ml-kem-768" },
): Promise<Bytes> {
  const impl = selectMlKem(cfg.variant);
  return await impl.decapsulate(ciphertext, secretKey);
}

export function createKem(
  cfg: KemConfig = { scheme: "ml-kem", variant: "ml-kem-768" },
) {
  const impl = selectMlKem(cfg.variant);
  return {
    keygen: (): KemKeyPair => impl.keyPair(),
    encapsulate: (pk: Bytes) => impl.encapsulate(pk),
    decapsulate: (ct: Bytes, sk: Bytes) => impl.decapsulate(ct, sk),
    variant: (cfg.variant ?? "ml-kem-768") as MlKemVariant,
  };
}
