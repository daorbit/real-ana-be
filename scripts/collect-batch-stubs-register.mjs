/** Registers the stub loader used by check-collect-batch.mjs. */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./collect-batch-stubs.mjs", pathToFileURL("./scripts/"));
