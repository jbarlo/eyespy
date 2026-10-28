/**
 * The feature cache's mutable state. It holds the RAM LRU, the encoded set, the frames whose stored file is
 * current, the frames that cannot be encoded, and the persist switch.
 */
import { Lru } from "../../../railway/index.ts";
import type { FrameNo } from "../../../video/pure.ts";
import type { FrameAccessError } from "../../../video/pure.ts";
import type { Features } from "../../pure.ts";

export class FeatureState {
  readonly ram: Lru<FrameNo, Features>;
  /** Frames whose features this instance produced or found in the trusted store. */
  private readonly done = new Set<FrameNo>();
  /** Frames whose stored file is current, because this instance wrote it or a trusted `scanStore` found it. */
  private readonly current = new Set<FrameNo>();
  /** Frames whose image can never be read. */
  private readonly broken = new Map<FrameNo, FrameAccessError>();
  private on: boolean;

  constructor(capacity: number, persist: boolean) {
    this.ram = new Lru(capacity);
    this.on = persist;
  }

  get persist(): boolean {
    return this.on;
  }
  setPersist(on: boolean): void {
    this.on = on;
  }
  isEncoded(i: FrameNo): boolean {
    return this.done.has(i);
  }
  markEncoded(i: FrameNo): void {
    this.done.add(i);
    this.broken.delete(i);
  }
  unmarkEncoded(i: FrameNo): void {
    this.done.delete(i);
    this.current.delete(i);
  }
  isStored(i: FrameNo): boolean {
    return this.current.has(i);
  }
  markStored(i: FrameNo): void {
    this.current.add(i);
  }
  unmarkStored(i: FrameNo): void {
    this.current.delete(i);
  }
  isFailed(i: FrameNo): boolean {
    return this.broken.has(i);
  }
  markFailed(i: FrameNo, e: FrameAccessError): void {
    this.broken.set(i, e);
  }
  forget(i: FrameNo): void {
    this.ram.delete(i);
    this.done.delete(i);
    this.current.delete(i);
    this.broken.delete(i);
  }
}
