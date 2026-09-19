export interface ChangedFile {
  path: string;
  kind: "created" | "modified" | "deleted";
}
