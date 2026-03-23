import fs from "fs";
import path from "path";

import { getSoundsRoot } from "@/lib/storage";

export interface LibrarySound {
  name: string;
  filename: string;
  category: string;
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

export const normalizeCategoryName = (value: string) => {
  const cleanValue = sanitizeSegment(path.basename(value || ""));
  return cleanValue || "Uncategorized";
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

  return path.join(baseSoundsPath, normalizedCategory);
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

export const listSoundLibrary = () => {
  ensureSoundsPath();

  const entries = fs.readdirSync(baseSoundsPath, { withFileTypes: true });
  const library: SoundLibrary = { Uncategorized: [] };

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const categoryPath = path.join(baseSoundsPath, entry.name);
      const sounds = fs
        .readdirSync(categoryPath)
        .filter(isSupportedAudioFile)
        .sort((left, right) => left.localeCompare(right))
        .map((filename) => ({
          name: path.basename(filename, path.extname(filename)),
          filename: `${entry.name}/${filename}`,
          category: entry.name,
        }));

      library[entry.name] = sounds;
      continue;
    }

    if (entry.isFile() && isSupportedAudioFile(entry.name)) {
      library.Uncategorized.push({
        name: path.basename(entry.name, path.extname(entry.name)),
        filename: entry.name,
        category: "Uncategorized",
      });
    }
  }

  library.Uncategorized.sort((left, right) => left.name.localeCompare(right.name));

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
