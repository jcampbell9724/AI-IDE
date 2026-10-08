import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_PROJECT_NAME_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/;

export function normalizeProjectName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Enter a project name.");
  if (name.length > 100) throw new Error("Project names must be 100 characters or fewer.");
  if (name === "." || name === "..") throw new Error("Choose a different project name.");
  if (INVALID_PROJECT_NAME_CHARACTER.test(name)) throw new Error("The project name contains a character Windows cannot use.");
  if (/[. ]$/.test(name)) throw new Error("Project names cannot end with a dot or space.");
  if (RESERVED_WINDOWS_NAME.test(name)) throw new Error("That project name is reserved by Windows.");
  return name;
}

export async function createProjectDirectory(parentDirectory: string, requestedName: string): Promise<string> {
  const name = normalizeProjectName(requestedName);
  const parent = await realpath(parentDirectory);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) throw new Error("Choose a folder where the project should be created.");

  const target = join(parent, name);
  if (dirname(target) !== parent) throw new Error("The project must be created directly inside the chosen folder.");

  try {
    await mkdir(target, { recursive: false });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error("A project with that name already exists in this location.");
    }
    throw error;
  }
  return target;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
