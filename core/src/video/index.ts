/**
 * The video module holds clips of one moment and their keyframes, with one global frame numbering across clips.
 * Removed clips keep their numbers as tombstones. A clip is a video file or a folder of frames, and its `timing`
 * says what its times mean.
 */
import type { CreateVideo } from "./types.ts";
import { VideoImpl } from "./internal/video.ts";

export type { FrameStore } from "./ports.ts";
export type { Clip, FrameNo, FrameRef } from "./pure.ts";
export type { CreateVideo, Video, VideoError } from "./types.ts";

export const createVideo: CreateVideo = (ports, opts) => new VideoImpl(ports, opts);
