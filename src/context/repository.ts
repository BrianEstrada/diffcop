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
  hashObject(path: string): Promise<string>;
}
