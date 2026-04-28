export type PressureInferenceModelConfig = {
  modelPath: string;
  modelName: string;
  cropSizePx: number;
  inputSizePx: number;
};

export const DEFAULT_PRESSURE_INFERENCE_MODEL_CONFIG = {
  modelPath: "/pressure_cnn_1777337025269_566175_crop180_only.onnx",
  modelName: "pressure_cnn_1777337025269_566175_crop180_only.onnx",
  cropSizePx: 180,
  inputSizePx: 180,
} as const satisfies PressureInferenceModelConfig;

export const PRESSURE_INFERENCE_DEFAULT_INFER_HZ = 10;
