export interface ActionPin {
  readonly file: string;
  readonly repo: string;
  readonly sha: string;
  readonly tag: string;
}

export interface PinMismatch extends ActionPin {
  readonly actual: string | null;
  readonly reason: string;
}

export type VerifyActionPinsResult =
  | { readonly skipped: true; readonly reason: string; readonly mismatches: readonly [] }
  | { readonly skipped: false; readonly mismatches: readonly PinMismatch[] };

export function findPins(): Promise<ActionPin[]>;
export function verifyActionPins(): Promise<VerifyActionPinsResult>;
