export type MediaKind = "image" | "video" | "audio" | "document";

const AUDIO_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".amr"];
const VIDEO_EXTS = [".mp4", ".3gp", ".mov", ".webm", ".mkv", ".avi"];
const DOC_EXTS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".vcf"];
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp"];

export function classifyMedia(url: string, contentType?: string): MediaKind {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("image/")) return "image";
  if (
    ct === "application/pdf" ||
    ct === "application/msword" ||
    ct.startsWith("application/vnd.") ||
    ct.startsWith("text/")
  ) {
    return "document";
  }

  const clean = (url || "").split("?")[0].toLowerCase();
  if (AUDIO_EXTS.some((ext) => clean.endsWith(ext))) return "audio";
  if (clean.endsWith(".webm") && (clean.includes("voice") || clean.includes("audio"))) {
    return "audio";
  }
  if (VIDEO_EXTS.some((ext) => clean.endsWith(ext))) return "video";
  if (DOC_EXTS.some((ext) => clean.endsWith(ext))) return "document";
  if (IMAGE_EXTS.some((ext) => clean.endsWith(ext))) return "image";
  return "image";
}

export function mediaLabel(kind: MediaKind): string {
  switch (kind) {
    case "audio":
      return "Audio";
    case "video":
      return "Video";
    case "document":
      return "Document";
    case "image":
    default:
      return "Image";
  }
}

export function fileNameFromUrl(url: string): string {
  try {
    const seg = url.split("?")[0].split("/").pop();
    return seg ? decodeURIComponent(seg) : "Attachment";
  } catch {
    return "Attachment";
  }
}
