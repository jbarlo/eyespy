import { MemStore } from "../fakes/index.ts";
import { sessionStoreContract } from "./session-store.ts";

sessionStoreContract("MemStore", async () => ({ store: new MemStore() }));
