export type RankLineContext = {
  bestLineIndex?: number;
  linesText?: string[][];
};

export type RankNearestWord = {
  text: string;
  distance: number;
  lineContext?: RankLineContext;
};

export type RankPointerSample = {
  timestamp: number;
  x: number;
  y: number;
  speed: number;
  nearestWord?: RankNearestWord;
};

export type RankTopicItem = {
  text: string;
};

export type RankHistoryItem = {
  text: string;
  timestamp?: number;
};

export type RankRequest = {
  sessionId?: string;
  pageId?: string;
  timestamp?: number;
  pageTopics: RankTopicItem[];
  selectedHistory?: RankHistoryItem[];
  pointerWindow: RankPointerSample[];
  topK?: number;
};

export type RankedTopic = {
  text: string;
  score: number;
  rank: number;
};

export type RankDebug = {
  focusTexts: string[];
  pointerCount: number;
  focusNorm: number;
  historyUsed: boolean;
};

export type RankResponse = {
  model: string;
  rankedTopics: RankedTopic[];
  debug: RankDebug;
};

