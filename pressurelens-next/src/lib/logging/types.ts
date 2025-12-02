export type InputMode = "pencil" | "finger";

export type NearestWordInfo = {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  distance: number;
};

export type PointerSample = {
  timestamp: number; // Unix ms
  x: number;
  y: number;
  speed: number; // px/s
  inputMode: InputMode;
  nearestWord: NearestWordInfo | null;
  pressure?: number;
  level?: "light" | "medium" | "hard";
  interestScore?: number;
};

export type PointerSampleInput = Omit<PointerSample, "speed"> & {
  speed?: number;
};

export type PageOcrInfo = {
  pageText: string;
  pageTopics: {
    text: string;
    weight: number;
    category?: string;
  }[];
};

export type VoiceAnnotation = {
  id: string;
  timestampStart: number;
  timestampEnd: number;
  transcript: string;
};

export type SelectedTopic = {
  id: string;
  timestamp: number;
  text: string;
  source: "page_topic" | "voice";
};

export type SessionConfig = {
  samplingHz: number;
};

export type SessionJson = {
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  deviceInfo?: string;
  config: SessionConfig;
  pageOcr?: PageOcrInfo;
  pointerSamples: PointerSample[];
  voiceAnnotations: VoiceAnnotation[];
  selectedTopics: SelectedTopic[];
};


