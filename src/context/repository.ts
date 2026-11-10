export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface Repository {
  root(): Promise<string>;
  defaultBase(): Promise<string>;
  mergeBase(ref: string): Promise<string>;
  currentBranch(): Promise<string>;
  commitsSince(ref: string): Promise<string[]>;
  changedFilesSince(ref: string): Promise<ChangedFile[]>;
  diffSince(ref: string): Promise<string>;
  headSha(): Promise<string>;
  // False too when the commit isn't in the clone.
  isAncestor(sha: string): Promise<boolean>;
  // `paths`' changes since `ref`, with `a/` and `b/` prefixes and unquoted paths whatever git's config.
  diffOfFilesSince(ref: string, paths: string[]): Promise<string>;
  hashObject(path: string): Promise<string>;
}
