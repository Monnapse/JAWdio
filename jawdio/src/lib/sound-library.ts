import fs from "fs";
import path from "path";

import { getSoundsRoot } from "@/lib/storage";

export interface LibrarySound {
  name: string;
  filename: string;
  category: string;
  /** File modification time in ms — used as a "saved at" timestamp. */
  createdAt: number;
}

export type SoundLibrary = Record<string, LibrarySound[]>;

const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F]/g;
const SUPPORTED_AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".ogg"]);
const baseSoundsPath = getSoundsRoot();

const sanitizeSegment = (value: string) =>
  value.replace(INVALID_FILENAME_CHARACTERS, " ").replace(/\s+/g, " ").trim();

export const ensureSoundsPath = () => {
  fs.mkdirSync(baseSoundsPath, { recursive: true });
};

/**
 * Normalize a possibly-nested category path. Each "/"-separated segment is
 * sanitised independently so users can express folders-of-folders like
 * "Drops/Air horns". Empty input falls back to the "Uncategorized" root.
 */
export const normalizeCategoryName = (value: string) => {
  if (!value) return "Uncategorized";

  const segments = value
    .split(/[\\/]+/)
    .map((segment) => sanitizeSegment(segment))
    .filter(Boolean);

  if (segments.length === 0) return "Uncategorized";

  // Collapse any explicit "Uncategorized" intermediate path back to the root —
  // we never want sounds living under <root>/Uncategorized/sub on disk.
  if (segments[0] === "Uncategorized") {
    if (segments.length === 1) return "Uncategorized";
    segments.shift();
  }

  return segments.join("/");
};

export const isSupportedAudioFile = (filename: string) =>
  SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase());

export const normalizeUploadFilename = (filename: string) => {
  const extension = path.extname(filename).toLowerCase();

  if (!SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
    return null;
  }

  const rawBaseName = path.basename(filename, extension);
  const cleanBaseName = sanitizeSegment(rawBaseName).replace(/\.+$/g, "");
  const finalBaseName = cleanBaseName || "sound";

  return `${finalBaseName}${extension}`;
};

export const resolveStoredSoundPath = (filename: string) => {
  const parts = filename
    .split(/[\\/]+/)
    .map((segment) => sanitizeSegment(segment))
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(baseSoundsPath, ...parts);

  if (!resolvedPath.startsWith(baseSoundsPath)) {
    return null;
  }

  return {
    absolutePath: resolvedPath,
    relativePath: path.relative(baseSoundsPath, resolvedPath).replace(/\\/g, "/"),
  };
};

export const getCategoryDirectory = (category: string) => {
  const normalizedCategory = normalizeCategoryName(category);

  if (normalizedCategory === "Uncategorized") {
    return baseSoundsPath;
  }

  const segments = normalizedCategory.split("/").filter(Boolean);
  const target = path.join(baseSoundsPath, ...segments);

  // Defence-in-depth: make sure we never escape the sounds root with a crafted
  // "../" segment that slipped past sanitizeSegment.
  if (!path.resolve(target).startsWith(path.resolve(baseSoundsPath))) {
    return baseSoundsPath;
  }

  return target;
};

export const ensureUniqueFilePath = (desiredPath: string, existingPath?: string) => {
  const extension = path.extname(desiredPath);
  const baseName = path.basename(desiredPath, extension);
  const directory = path.dirname(desiredPath);

  let candidatePath = desiredPath;
  let suffix = 2;

  while (
    fs.existsSync(candidatePath) &&
    path.resolve(candidatePath) !== path.resolve(existingPath ?? "")
  ) {
    candidatePath = path.join(directory, `${baseName} ${suffix}${extension}`);
    suffix += 1;
  }

  return candidatePath;
};

const safeStatMs = (absolutePath: string) => {
  try {
    return fs.statSync(absolutePath).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Recursive directory walk. Every folder at any depth becomes a key in the
 * returned map; the key is the slash-separated path relative to the sounds
 * root (the empty path "" becomes the special "Uncategorized" key for back-
 * compat with all existing UI code). Audio files inside a folder are listed
 * directly under that folder's key — they do NOT bubble up.
 */
const collectFolders = (absoluteDir: string, relativeKey: string, library: SoundLibrary) => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  const folderKey = relativeKey === "" ? "Uncategorized" : relativeKey;

  if (!library[folderKey]) {
    library[folderKey] = [];
  }

  for (const entry of entries) {
    const entryAbsolute = path.join(absoluteDir, entry.name);

    if (entry.isDirectory()) {
      const nextRelative = relativeKey === "" ? entry.name : `${relativeKey}/${entry.name}`;
      collectFolders(entryAbsolute, nextRelative, library);
      continue;
    }

    if (entry.isFile() && isSupportedAudioFile(entry.name)) {
      const filenameKey =
        relativeKey === "" ? entry.name : `${relativeKey}/${entry.name}`;

      library[folderKey].push({
        name: path.basename(entry.name, path.extname(entry.name)),
        filename: filenameKey,
        category: folderKey,
        createdAt: safeStatMs(entryAbsolute),
      });
    }
  }
};

export const listSoundLibrary = () => {
  ensureSoundsPath();

  const library: SoundLibrary = { Uncategorized: [] };
  collectFolders(baseSoundsPath, "", library);

  // Within each folder, sort by name for stable rendering.
  for (const key of Object.keys(library)) {
    library[key].sort((left, right) => left.name.localeCompare(right.name));
  }

  // Order keys: Uncategorized first, then alphabetical by path. The frontend
  // uses these keys directly to build the rendered tree, so a consistent
  // alphabetical order keeps the UI stable across requests.
  return Object.fromEntries(
    Object.entries(library).sort(([left], [right]) => {
      if (left === "Uncategorized") {
        return -1;
      }

      if (right === "Uncategorized") {
        return 1;
      }

      return left.localeCompare(right);
    }),
  ) as SoundLibrary;
};
