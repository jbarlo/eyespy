/**
 * The session's own state: the saved config and the format stamps. The methods replace the class fields, and every
 * value handed out is immutable.
 */
import type { SessionMeta } from "../ports.ts";
import type { Config, ConfigKey } from "../pure.ts";
import { CONFIG_KEYS, DEFAULT_CONFIG } from "../pure.ts";
import { Lru } from "../../railway/index.ts";
import type { TrackFrame } from "../../tracking/index.ts";
import {
  EMPTY_ASSOC,
  EMPTY_TRACK_INDEX,
  type AssocData,
  type TrackIndex,
  type TrackMemory,
} from "../../tracking/pure.ts";
import type { ClipKey } from "../../video/pure.ts";

export type Formats = SessionMeta["formats"];

/** Only the keys that differ from the defaults, as session.json stores them. */
const changed = (cfg: Config): Partial<Config> =>
  Object.fromEntries(CONFIG_KEYS.filter((k) => cfg[k] !== DEFAULT_CONFIG[k]).map((k) => [k, cfg[k]]));

/** Track legs whose memory stays in RAM, at about 4 MB each. The rest wait on disk. */
const KEPT_MEMORIES = 16;

/** The saved tracks, as last read or written, and what units keep between them. Only used with tracking on. */
export class TrackBook {
  private value: TrackIndex = EMPTY_TRACK_INDEX;
  private links: AssocData = EMPTY_ASSOC;
  private held: { readonly clip: ClipKey; readonly at: number; readonly frame: TrackFrame } | null = null;
  private readonly memories = new Lru<string, TrackMemory>(KEPT_MEMORIES);

  index(): TrackIndex {
    return this.value;
  }
  set(index: TrackIndex): void {
    this.value = index;
  }
  assoc(): AssocData {
    return this.links;
  }
  setAssoc(assoc: AssocData): void {
    this.links = assoc;
  }
  hold(clip: ClipKey, at: number, frame: TrackFrame): void {
    this.held = { clip, at, frame };
  }
  heldPlace(): { readonly clip: ClipKey; readonly at: number } | null {
    return this.held;
  }
  heldFrame(clip: ClipKey, at: number): TrackFrame | null {
    return this.held && this.held.clip === clip && this.held.at === at ? this.held.frame : null;
  }
  memory(key: string): TrackMemory | undefined {
    return this.memories.get(key);
  }
  keepMemory(key: string, m: TrackMemory): void {
    this.memories.set(key, m);
  }
  /** Frees what is held in RAM. Everything in it can be read again or made again. */
  letGo(): void {
    this.held = null;
    this.memories.clear();
  }
}

export class SessionState {
  private cfg: Config;
  private stamps: Formats;
  private readonly version: number;

  constructor(meta: SessionMeta) {
    this.version = meta.version;
    this.cfg = { ...DEFAULT_CONFIG, ...meta.config };
    this.stamps = meta.formats;
  }

  config(): Config {
    return this.cfg;
  }
  formats(): Formats {
    return this.stamps;
  }
  /** session.json's session part with these changes applied. `saved` adopts them. */
  meta(clips: SessionMeta["clips"], change: { readonly config?: Config; readonly formats?: Formats } = {}) {
    const meta: SessionMeta = {
      version: this.version,
      config: changed(change.config ?? this.cfg),
      clips,
      formats: change.formats ?? this.stamps,
    };
    return meta;
  }

  /** Adopts what was just written. */
  saved(change: { readonly config?: Config; readonly formats?: Formats } = {}): void {
    if (change.config) this.cfg = change.config;
    if (change.formats) this.stamps = change.formats;
  }

  withSetting(k: ConfigKey, v: number): Config {
    return { ...this.cfg, [k]: v };
  }
}
