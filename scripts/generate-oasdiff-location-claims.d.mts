export interface OasdiffCheckLocations {
  readonly locations?: readonly string[];
}

export interface DerivedLocationClaim {
  readonly pattern: string;
  readonly actions: string[];
}

export interface LocationClaimsFile {
  readonly oasdiffVersion: string;
  readonly claims: DerivedLocationClaim[];
}

export function deriveLocationClaims(
  checks: readonly OasdiffCheckLocations[],
): DerivedLocationClaim[];
export function generate(oasdiffVersion: string): Promise<LocationClaimsFile>;
