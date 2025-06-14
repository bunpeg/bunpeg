import type { AudioFormat, ImageFormat, VideoFormat } from '../schemas.ts';

export const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/x-matroska",    // .mkv
  "video/quicktime",     // .mov
  "video/x-msvideo",     // .avi
  "video/webm",
  "video/mpeg",          // .mpeg
  "audio/mpeg",          // .mp3
  "audio/mp4",           // .m4a
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/flac",
  "audio/x-wav",
];

export const ALLOWED_VIDEO_FORMATS: VideoFormat[] = [
  "mp4",
  "mkv",
  "webm",
  "mov",
  "avi",
];

export const ALLOWED_AUDIO_FORMATS: AudioFormat[] = [
  "mp3",
  "m4a",
  "aac",
  "flac",
  "wav",
  "opus",
];

export const ALLOWED_IMAGE_EXTENSIONS: ImageFormat[] = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "svg",
];
