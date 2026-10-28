/**
 * The session's own state: the saved config and the format stamps. The methods replace the class fields, and every
 * value handed out is immutable.
 */
import type { SessionMeta } from "../ports.ts";
import type { Config, ConfigKey } from "../pure.ts";
import { CONFIG_KEYS, DEFAULT_CONFIG } from "../pure.ts";

export type Formats = SessionMeta["formats"];

/** Only the keys that differ from the defaults, as session.json stores them. */
const changed = (cfg: Config): Partial<Config> =>
  Object.fromEntries(CONFIG_KEYS.filter((k) => cfg[k] !== DEFAULT_CONFIG[k]).map((k) => [k, cfg[k]]));

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
