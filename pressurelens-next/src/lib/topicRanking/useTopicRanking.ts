"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerSampleInput } from "../logging/types";
import type {
  RankDebug,
  RankHistoryItem,
  RankNearestWord,
  RankPointerSample,
  RankRequest,
  RankResponse,
  RankedTopic,
} from "./types";

type UseTopicRankingOptions = {
  sessionId?: string;
  pageId?: string;
  pageTopics: string[] | null;
  enabled?: boolean;
  topK?: number;
  windowMs?: number;
  requestIntervalMs?: number;
};

type UseTopicRankingResult = {
  rankedTopics: RankedTopic[];
  rankedTopicMap: Map<string, RankedTopic>;
  debug: RankDebug | null;
  model: string | null;
  isLoading: boolean;
  error: string | null;
  pushPointerSample: (sample: PointerSampleInput) => void;
  pushSelectedTopic: (text: string, timestamp?: number) => void;
  reset: () => void;
};

const DEFAULT_WINDOW_MS = 4000;
const DEFAULT_REQUEST_INTERVAL_MS = 400;
const DEFAULT_TOP_K = 5;
const MAX_SELECTED_HISTORY = 20;

function normalizeTopicKey(text: string): string {
  return text.trim().toLowerCase();
}

function computeSpeed(
  prev: RankPointerSample | undefined,
  current: PointerSampleInput
): number {
  if (typeof current.speed === "number" && Number.isFinite(current.speed)) {
    return current.speed;
  }
  if (!prev) return 0;
  const dt = current.timestamp - prev.timestamp;
  if (dt <= 0) return 0;
  const dx = current.x - prev.x;
  const dy = current.y - prev.y;
  return (Math.hypot(dx, dy) / dt) * 1000;
}

function toRankNearestWord(
  nearestWord: PointerSampleInput["nearestWord"]
): RankNearestWord | undefined {
  if (!nearestWord) return undefined;
  return {
    text: nearestWord.text,
    distance: nearestWord.distance,
    lineContext: nearestWord.lineContext
      ? {
          bestLineIndex: nearestWord.lineContext.bestLineIndex,
          linesText: nearestWord.lineContext.linesText,
        }
      : undefined,
  };
}

export function useTopicRanking({
  sessionId,
  pageId,
  pageTopics,
  enabled = true,
  topK = DEFAULT_TOP_K,
  windowMs = DEFAULT_WINDOW_MS,
  requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
}: UseTopicRankingOptions): UseTopicRankingResult {
  const [rankedTopics, setRankedTopics] = useState<RankedTopic[]>([]);
  const [debug, setDebug] = useState<RankDebug | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pageTopicsRef = useRef<string[] | null>(pageTopics);
  const pointerWindowRef = useRef<RankPointerSample[]>([]);
  const selectedHistoryRef = useRef<RankHistoryItem[]>([]);
  const lastRequestStartedAtRef = useRef<number>(0);
  const scheduledRequestRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const clearScheduledRequest = () => {
    if (scheduledRequestRef.current !== null) {
      window.clearTimeout(scheduledRequestRef.current);
      scheduledRequestRef.current = null;
    }
  };

  const abortInFlightRequest = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const prunePointerWindow = (now: number) => {
    const threshold = now - windowMs;
    pointerWindowRef.current = pointerWindowRef.current.filter(
      (sample) => sample.timestamp >= threshold
    );
  };

  const requestRanking = async () => {
    clearScheduledRequest();

    if (!enabled) return;

    const topics = (pageTopicsRef.current ?? [])
      .map((text) => text.trim())
      .filter(Boolean);

    if (topics.length === 0) {
      setRankedTopics([]);
      setDebug(null);
      setModel(null);
      setError(null);
      return;
    }

    const now = Date.now();
    prunePointerWindow(now);

    if (pointerWindowRef.current.length === 0) {
      setRankedTopics([]);
      setDebug(null);
      setModel(null);
      setError(null);
      return;
    }

    const payload: RankRequest = {
      sessionId,
      pageId,
      timestamp: now,
      pageTopics: topics.map((text) => ({ text })),
      selectedHistory: selectedHistoryRef.current.slice(-MAX_SELECTED_HISTORY),
      pointerWindow: [...pointerWindowRef.current],
      topK,
    };

    abortInFlightRequest();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    lastRequestStartedAtRef.current = now;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/topic-rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(errorText || `Topic rank request failed: ${res.status}`);
      }

      const data = (await res.json()) as RankResponse;
      setRankedTopics(Array.isArray(data.rankedTopics) ? data.rankedTopics : []);
      setDebug(data.debug ?? null);
      setModel(data.model ?? null);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      console.error("[TopicRanking] request failed", err);
      setRankedTopics([]);
      setDebug(null);
      setModel(null);
      setError((err as Error).message || "Failed to rank topics");
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsLoading(false);
    }
  };

  const scheduleRanking = () => {
    if (!enabled) return;

    const elapsed = Date.now() - lastRequestStartedAtRef.current;
    if (elapsed >= requestIntervalMs) {
      void requestRanking();
      return;
    }

    if (scheduledRequestRef.current !== null) {
      return;
    }

    scheduledRequestRef.current = window.setTimeout(() => {
      void requestRanking();
    }, requestIntervalMs - elapsed);
  };

  const pushPointerSample = (sample: PointerSampleInput) => {
    const prev = pointerWindowRef.current[pointerWindowRef.current.length - 1];
    const normalized: RankPointerSample = {
      timestamp: sample.timestamp,
      x: sample.x,
      y: sample.y,
      speed: computeSpeed(prev, sample),
      nearestWord: toRankNearestWord(sample.nearestWord),
    };

    pointerWindowRef.current.push(normalized);
    prunePointerWindow(sample.timestamp);
    scheduleRanking();
  };

  const pushSelectedTopic = (text: string, timestamp = Date.now()) => {
    const normalized = text.trim();
    if (!normalized) return;

    selectedHistoryRef.current = [
      ...selectedHistoryRef.current.slice(-(MAX_SELECTED_HISTORY - 1)),
      { text: normalized, timestamp },
    ];
    scheduleRanking();
  };

  const reset = () => {
    clearScheduledRequest();
    abortInFlightRequest();
    pointerWindowRef.current = [];
    selectedHistoryRef.current = [];
    lastRequestStartedAtRef.current = 0;
    setRankedTopics([]);
    setDebug(null);
    setModel(null);
    setError(null);
    setIsLoading(false);
  };

  useEffect(() => {
    pageTopicsRef.current = pageTopics;

    if (!pageTopics || pageTopics.length === 0) {
      setRankedTopics([]);
      setDebug(null);
      setModel(null);
      setError(null);
      return;
    }

    scheduleRanking();
  }, [pageTopics, enabled, pageId, sessionId, topK]);

  useEffect(() => {
    return () => {
      clearScheduledRequest();
      abortInFlightRequest();
    };
  }, []);

  const rankedTopicMap = useMemo(() => {
    return new Map(
      rankedTopics.map((topic) => [normalizeTopicKey(topic.text), topic])
    );
  }, [rankedTopics]);

  return {
    rankedTopics,
    rankedTopicMap,
    debug,
    model,
    isLoading,
    error,
    pushPointerSample,
    pushSelectedTopic,
    reset,
  };
}
