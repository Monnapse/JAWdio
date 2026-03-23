import type { MediaKind } from "@/lib/storage";

export const buildMediaUrl = (kind: MediaKind, relativePath: string) => {
  const safePath = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/api/media/${kind}/${safePath}`;
};
