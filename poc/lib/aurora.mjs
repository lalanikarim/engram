// Back-compat shim — the provider wiring now lives in ./model.mjs and is
// inference-host/model-agnostic (PI_PROVIDER_ID / PI_MODEL_ID env config).
// New code should import from ./model.mjs; this file keeps existing imports
// (including cross-repo consumers) working unchanged.
export {
  loadModelConfig as loadAuroraConfig,
  modelId as auroraModelId,
  localModels as auroraModels,
} from "./model.mjs";
