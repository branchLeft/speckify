export interface OasdiffCheckLocations {
  readonly locations?: readonly string[];
}

export interface CoveredKeywordsFile {
  readonly oasdiffVersion: string;
  readonly keywords: readonly string[];
}

export function deriveCoveredKeywords(checks: readonly OasdiffCheckLocations[]): string[];
export function generate(oasdiffVersion: string): Promise<CoveredKeywordsFile>;
