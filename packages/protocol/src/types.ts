/** Git object types mapped to wire type bytes. */
export const ObjectType = {
  COMMIT: 1,
  TREE: 2,
  BLOB: 3,
  TAG: 4,
  DELTA: 5,
} as const;

export type ObjectTypeByte = (typeof ObjectType)[keyof typeof ObjectType];

export const HASH_BYTES = 20;

/** A 40-char lowercase hex SHA-1. */
export type Sha1Hex = string;

// --- Control messages ---

export interface PushRequest {
  id: number;
  ref: string;
  new: Sha1Hex;
  old?: Sha1Hex;
  force?: boolean;
}

export interface PushDone {
  id: number;
  status: "done";
  ref: string;
  hash: Sha1Hex;
}

export interface PushError {
  id: number;
  status: "error";
  message: string;
  [key: string]: unknown;
}

export type PushResponse = PushDone | PushError;

export interface FetchRequest {
  id: number;
  ref: string;
}

export interface FetchRefs {
  id: number;
  status: "refs";
  refs: Record<string, Sha1Hex>;
}

export interface FetchDone {
  id: number;
  status: "done";
}

export type ServerMessage = PushResponse | FetchRefs;
export type ClientFetchMessage = FetchRequest | FetchDone;
