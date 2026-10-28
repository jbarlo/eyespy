import type {
  AddReply,
  AddReq,
  ClipsListReply,
  ClipsListReq,
  ClipsRemoveReply,
  ClipsRemoveReq,
  ConfigReply,
  ConfigReq,
  CropReply,
  CropReq,
  DataDetsReply,
  DataDetsReq,
  DataFramesReply,
  DataObjectsReply,
  DataRunsReply,
  DataRunsReq,
  DetsReq,
  Engine,
  FeaturesReply,
  FeaturesReq,
  FindReply,
  FindReq,
  FrameSpecReq,
  GapsReply,
  HistoryView,
  HitsReply,
  ManifestReply,
  ManifestReq,
  ObjDeleteReply,
  ObjIdsReq,
  ObjLabelReq,
  ObjMatchReply,
  ObjMatchReq,
  ObjMergeReq,
  ObjNewReq,
  ObjReq,
  ObjShowReply,
  ObjShowReq,
  ObjSuggestReply,
  ObjSuggestReq,
  ObjectSummary,
  RedoReply,
  RejectReply,
  RejectReq,
  SearchReply,
  SearchReq,
  SemanticReply,
  SemanticReq,
  SessionError,
  SheetReply,
  ShowReq,
  SimilarReply,
  SimilarReq,
  StatusReply,
  TodoReply,
  TodoReq,
  UndoReply,
} from "../session/index.ts";
import type { OpPath } from "./pure.ts";

/** The tRPC context, which is the one engine this process serves. */
export type Context = { readonly engine: Engine };

/** Per-call config overrides every mutation but shutdown accepts (`eyespy --threshold 0.4 ...`). */
export type WithCfg = { readonly cfg?: Readonly<Record<string, number>> };

type Io<I, O> = { readonly in: I; readonly out: O };
type Empty = Record<never, never>;

/** Input and output of every op. Hosts type their callers from this, and the router's zod schemas must agree. */
export type OpIo = {
  readonly status: Io<WithCfg, StatusReply>;
  readonly add: Io<AddReq & WithCfg, AddReply>;
  readonly "clips.list": Io<ClipsListReq & WithCfg, ClipsListReply>;
  readonly "clips.remove": Io<ClipsRemoveReq & WithCfg, ClipsRemoveReply>;
  readonly config: Io<ConfigReq & WithCfg, ConfigReply>;
  readonly sheet: Io<FrameSpecReq & WithCfg, SheetReply>;
  readonly find: Io<FindReq & WithCfg, FindReply>;
  readonly search: Io<SearchReq & WithCfg, SearchReply>;
  readonly semantic: Io<SemanticReq & WithCfg, SemanticReply>;
  readonly show: Io<ShowReq & WithCfg, HitsReply>;
  readonly crop: Io<CropReq & WithCfg, CropReply>;
  readonly similar: Io<SimilarReq & WithCfg, SimilarReply>;
  readonly dets: Io<DetsReq & WithCfg, HitsReply>;
  readonly "obj.new": Io<ObjNewReq & WithCfg, ObjectSummary>;
  readonly "obj.add": Io<ObjIdsReq & WithCfg, ObjectSummary>;
  readonly "obj.remove": Io<ObjIdsReq & WithCfg, ObjectSummary>;
  readonly "obj.merge": Io<ObjMergeReq & WithCfg, ObjectSummary>;
  readonly "obj.label": Io<ObjLabelReq & WithCfg, ObjectSummary>;
  readonly "obj.delete": Io<ObjReq & WithCfg, ObjDeleteReply>;
  readonly "obj.show": Io<ObjShowReq & WithCfg, ObjShowReply>;
  readonly "obj.suggest": Io<ObjSuggestReq & WithCfg, ObjSuggestReply>;
  readonly "obj.match": Io<ObjMatchReq & WithCfg, ObjMatchReply>;
  readonly reject: Io<RejectReq & WithCfg, RejectReply>;
  readonly todo: Io<TodoReq & WithCfg, TodoReply>;
  readonly features: Io<FeaturesReq & WithCfg, FeaturesReply>;
  readonly undo: Io<WithCfg, UndoReply>;
  readonly redo: Io<WithCfg, RedoReply>;
  readonly gaps: Io<FrameSpecReq & WithCfg, GapsReply>;
  readonly manifest: Io<ManifestReq & WithCfg, ManifestReply>;
  readonly shutdown: Io<void, { readonly ok: true }>;
  readonly "data.frames": Io<Empty | undefined, DataFramesReply>;
  readonly "data.dets": Io<DataDetsReq | undefined, DataDetsReply>;
  readonly "data.runs": Io<DataRunsReq | undefined, DataRunsReply>;
  readonly "data.objects": Io<Empty | undefined, DataObjectsReply>;
  readonly "data.history": Io<Empty | undefined, HistoryView>;
};
export type Inputs = { readonly [P in OpPath]: OpIo[P]["in"] };
export type Outputs = { readonly [P in OpPath]: OpIo[P]["out"] };

export type ErrorCode = "BAD_REQUEST" | "INTERNAL_SERVER_ERROR";
type ErrorKind = SessionError["kind"];
type ErrorRule<E> = {
  /** Fixed per kind, unless the error says more. */
  readonly code: ErrorCode | ((e: E) => ErrorCode);
  /** The message agents see. */
  readonly message: (e: E) => string;
};
/** A new error kind fails to compile until it has a rule here. */
export type ErrorTable = { readonly [K in ErrorKind]: ErrorRule<Extract<SessionError, { readonly kind: K }>> };
