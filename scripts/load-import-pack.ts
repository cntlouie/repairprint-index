import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { IMPORT_FILE_NAMES, type ImportFiles } from "../src/lib/csv-import";

export function loadImportPack(directory: string): ImportFiles {
  return Object.fromEntries(IMPORT_FILE_NAMES.map((file) => {
    try {
      return [file, readFileSync(resolve(directory, file), "utf8")];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`IMPORT_FILE_MISSING:${file}`);
      }
      throw error;
    }
  })) as ImportFiles;
}
