import path from "path";

export type MediaKind = "sounds" | "clips";

const INVALID_PATH_CHARACTERS = /[<>:"|?*\u0000-\u001F]/g;

const sanitizePathSegment = (value: string) =>
  value
    .replace(INVALID_PATH_CHARACTERS, " ")
    .replace(/[\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const resolveDataRoot = () => {
  const configuredRoot = process.env.JAWDIO_DATA_DIR?.trim();

  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  return path.resolve(process.cwd(), "public");
};

const normalizeRequestedPath = (requestedPath: string | string[]) =>
  (Array.isArray(requestedPath) ? requestedPath : requestedPath.split(/[\\/]+/))
    .map((segment) => sanitizePathSegment(path.basename(segment)))
    .filter(Boolean);

export const getDataRoot = () => resolveDataRoot();

export const getSoundsRoot = () => path.join(resolveDataRoot(), "sounds");

export const getClipsRoot = () => path.join(resolveDataRoot(), "clips");

export const getTempHandoffPath = () => path.join(resolveDataRoot(), "temp_handoff.webm");

export const resolveMediaPath = (kind: MediaKind, requestedPath: string | string[]) => {
  const baseDir = kind === "sounds" ? getSoundsRoot() : getClipsRoot();
  const normalizedBaseDir = path.resolve(baseDir);
  const segments = normalizeRequestedPath(requestedPath);

  if (segments.length === 0) {
    return null;
  }

  const absolutePath = path.resolve(normalizedBaseDir, ...segments);

  if (!absolutePath.startsWith(normalizedBaseDir)) {
    return null;
  }

  return {
    absolutePath,
    relativePath: path.relative(normalizedBaseDir, absolutePath).replace(/\\/g, "/"),
  };
};
