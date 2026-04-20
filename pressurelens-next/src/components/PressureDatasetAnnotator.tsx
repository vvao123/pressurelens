"use client";

import Link from "next/link";
import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  downloadBlob,
  toErrorMessage,
  type PressureDatasetManifest,
  type PressureLabel,
  type PressureSessionReview,
  type PressureSessionSummary,
} from "@/lib/pressureDataset/shared";

type LoadedDataset = {
  fileName: string;
  zip: JSZip;
  manifest: PressureDatasetManifest;
  sessions: PressureSessionSummary[];
};

type SelectedAssets = {
  videoUrl: string | null;
  patchUrls: string[];
};

const LABELS: PressureLabel[] = ["no_press", "light", "firm"];
const QUALITIES: PressureSessionReview["quality"][] = ["good", "usable", "bad"];

function buildLabelCounts(sessions: PressureSessionSummary[]) {
  return sessions.reduce<Record<PressureLabel, number>>(
    (acc, session) => {
      acc[session.label] += 1;
      return acc;
    },
    { no_press: 0, light: 0, firm: 0 }
  );
}

function makeDefaultReview(
  datasetId: string,
  session: PressureSessionSummary
): PressureSessionReview {
  return {
    dataset_id: datasetId,
    session_id: session.session_id,
    original_label: session.label,
    reviewed_label: session.label,
    press_start_frame: null,
    press_end_frame: null,
    press_start_ms: null,
    press_end_ms: null,
    keep: true,
    quality: session.clip_saved ? "good" : "usable",
    has_clip: session.clip_saved,
    clip_path: session.clip_path,
    notes: "",
    review_timestamp: Date.now(),
  };
}

function formatPressRange(review: PressureSessionReview | undefined) {
  if (!review?.press_start_frame || !review.press_end_frame) return "range not set";
  return `press ${review.press_start_frame}-${review.press_end_frame}`;
}

export default function PressureDatasetAnnotator() {
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "exporting" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string>("Import a dataset zip to begin review.");
  const [error, setError] = useState<string | null>(null);
  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedAssets, setSelectedAssets] = useState<SelectedAssets>({
    videoUrl: null,
    patchUrls: [],
  });
  const [reviews, setReviews] = useState<Record<string, PressureSessionReview>>({});
  const [touchedReviews, setTouchedReviews] = useState<Record<string, boolean>>({});
  const [showOnlyClipSessions, setShowOnlyClipSessions] = useState<boolean>(false);

  const assetUrlsRef = useRef<string[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const revokeAssetUrls = () => {
    assetUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    assetUrlsRef.current = [];
  };

  const selectedSession = useMemo(
    () => dataset?.sessions.find((session) => session.session_id === selectedSessionId) ?? null,
    [dataset, selectedSessionId]
  );

  const filteredSessions = useMemo(() => {
    const sessions = dataset?.sessions ?? [];
    if (!showOnlyClipSessions) return sessions;
    return sessions.filter((session) => session.clip_saved);
  }, [dataset, showOnlyClipSessions]);

  const reviewedCount = useMemo(
    () => Object.values(touchedReviews).filter(Boolean).length,
    [touchedReviews]
  );

  const selectedReview = useMemo(() => {
    if (!selectedSession || !dataset) return null;
    return reviews[selectedSession.session_id] ?? makeDefaultReview(dataset.manifest.dataset_id, selectedSession);
  }, [dataset, reviews, selectedSession]);

  const parseExistingReviews = async (zip: JSZip) => {
    const existingJsonl = zip.file("annotations/session_reviews.jsonl");
    if (!existingJsonl) return {};
    const text = await existingJsonl.async("string");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const next: Record<string, PressureSessionReview> = {};
    for (const line of lines) {
      try {
        const review = JSON.parse(line) as PressureSessionReview;
        next[review.session_id] = review;
      } catch {}
    }
    return next;
  };

  const loadDatasetFile = async (file: File) => {
    setStatus("loading");
    setError(null);
    setMessage(`Loading ${file.name}...`);
    revokeAssetUrls();
    setSelectedAssets({ videoUrl: null, patchUrls: [] });

    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const manifestEntry = zip.file("dataset.manifest.json") ?? zip.file(/manifest\.json$/)[0];

      let sessionSummaries: PressureSessionSummary[] = [];
      const indexEntry = zip.file("sessions/index.json");
      if (indexEntry) {
        sessionSummaries = JSON.parse(await indexEntry.async("string")) as PressureSessionSummary[];
      } else {
        const sessionEntries = zip
          .file(/^sessions\/.+\.json$/)
          .filter((entry) => !entry.name.endsWith("index.json"));
        sessionSummaries = await Promise.all(
          sessionEntries.map(async (entry) => JSON.parse(await entry.async("string")) as PressureSessionSummary)
        );
      }
      sessionSummaries.sort((a, b) => b.started_at - a.started_at);

      const manifest: PressureDatasetManifest = manifestEntry
        ? (JSON.parse(await manifestEntry.async("string")) as PressureDatasetManifest)
        : {
            dataset_id: file.name.replace(/\.zip$/i, ""),
            created_at: Date.now(),
            schema_version: "pressure-temporal-v1",
            runtime_input_mode: "raw_video_fingertip_crop",
            session_ids: sessionSummaries.map((session) => session.session_id),
            session_count: sessionSummaries.length,
            patch_count: sessionSummaries.reduce((sum, session) => sum + session.frame_count, 0),
            clip_count: sessionSummaries.filter((session) => session.clip_saved).length,
            sequence_hz: sessionSummaries[0]?.sequence_hz ?? 10,
            session_duration_ms: sessionSummaries[0]?.duration_ms ?? 3000,
            label_counts: buildLabelCounts(sessionSummaries),
            files: {
              manifest: "dataset.manifest.json",
              sessions_dir: "sessions",
              patches_dir: "patches",
              clips_dir: "clips",
              annotations_dir: "annotations",
            },
          };

      const existingReviews = await parseExistingReviews(zip);
      const nextReviews: Record<string, PressureSessionReview> = {};
      const nextTouched: Record<string, boolean> = {};
      for (const session of sessionSummaries) {
        const defaultReview = makeDefaultReview(manifest.dataset_id, session);
        const existingReview = existingReviews[session.session_id];
        nextReviews[session.session_id] =
          existingReview ? { ...defaultReview, ...existingReview } : defaultReview;
        nextTouched[session.session_id] = Boolean(existingReview);
      }

      setDataset({
        fileName: file.name,
        zip,
        manifest,
        sessions: sessionSummaries,
      });
      setReviews(nextReviews);
      setTouchedReviews(nextTouched);
      setSelectedSessionId(sessionSummaries[0]?.session_id ?? null);
      setStatus("ready");
      setMessage(`Loaded ${sessionSummaries.length} sessions from ${file.name}.`);
    } catch (loadError: unknown) {
      setStatus("error");
      setError(toErrorMessage(loadError));
      setMessage("Failed to open the dataset zip.");
    }
  };

  const updateSelectedReview = (patch: Partial<PressureSessionReview>) => {
    if (!dataset || !selectedSession) return;
    setReviews((current) => ({
      ...current,
      [selectedSession.session_id]: {
        ...(current[selectedSession.session_id] ?? makeDefaultReview(dataset.manifest.dataset_id, selectedSession)),
        ...patch,
        review_timestamp: Date.now(),
      },
    }));
    setTouchedReviews((current) => ({ ...current, [selectedSession.session_id]: true }));
  };

  const clampSelectedFrame = (frame: number) => {
    if (!selectedSession) return null;
    if (!Number.isFinite(frame)) return null;
    return Math.min(selectedSession.frame_count, Math.max(1, Math.round(frame)));
  };

  const frameToStartMs = (frame: number | null) => {
    if (!selectedSession || frame == null) return null;
    return Math.round(((frame - 1) / selectedSession.sequence_hz) * 1000);
  };

  const frameToEndMs = (frame: number | null) => {
    if (!selectedSession || frame == null) return null;
    return Math.round((frame / selectedSession.sequence_hz) * 1000);
  };

  const updatePressRange = (startFrame: number | null, endFrame: number | null) => {
    const start = startFrame == null ? null : clampSelectedFrame(startFrame);
    const end = endFrame == null ? null : clampSelectedFrame(endFrame);
    updateSelectedReview({
      press_start_frame: start,
      press_end_frame: end,
      press_start_ms: frameToStartMs(start),
      press_end_ms: frameToEndMs(end),
    });
  };

  const setPressStartFrame = (value: string) => {
    const parsed = value.trim() === "" ? null : Number(value);
    const start = parsed == null ? null : clampSelectedFrame(parsed);
    const currentEnd = selectedReview?.press_end_frame ?? null;
    const end = start != null && currentEnd != null && currentEnd < start ? start : currentEnd;
    updatePressRange(start, end);
  };

  const setPressEndFrame = (value: string) => {
    const parsed = value.trim() === "" ? null : Number(value);
    const end = parsed == null ? null : clampSelectedFrame(parsed);
    const currentStart = selectedReview?.press_start_frame ?? null;
    const start = end != null && currentStart != null && currentStart > end ? end : currentStart;
    updatePressRange(start, end);
  };

  const setBoundaryFromVideo = (boundary: "start" | "end") => {
    if (!selectedSession || !videoRef.current) return;
    const frame = clampSelectedFrame(
      Math.floor(videoRef.current.currentTime * selectedSession.sequence_hz) + 1
    );
    if (frame == null) return;
    if (boundary === "start") {
      const end = selectedReview?.press_end_frame ?? null;
      updatePressRange(frame, end != null && end < frame ? frame : end);
      return;
    }
    const start = selectedReview?.press_start_frame ?? null;
    updatePressRange(start != null && start > frame ? frame : start, frame);
  };

  const setWholePressRange = () => {
    if (!selectedSession) return;
    updatePressRange(1, selectedSession.frame_count);
  };

  const clearPressRange = () => {
    updatePressRange(null, null);
  };

  const exportReviewsJsonl = async () => {
    if (!dataset) return;
    setStatus("exporting");
    setMessage("Packaging annotation JSONL...");
    try {
      const ordered = dataset.sessions.map((session) => reviews[session.session_id]);
      const lines = ordered.map((review) => JSON.stringify(review));
      downloadBlob(
        new Blob([`${lines.join("\n")}\n`], { type: "application/json" }),
        `${dataset.manifest.dataset_id}-session_reviews.jsonl`
      );
      setStatus("ready");
      setMessage("Annotation JSONL downloaded.");
    } catch (exportError: unknown) {
      setStatus("error");
      setError(toErrorMessage(exportError));
      setMessage("Failed to export annotations.");
    }
  };

  const exportReviewedZip = async () => {
    if (!dataset) return;
    setStatus("exporting");
    setMessage("Packaging reviewed zip...");
    try {
      const ordered = dataset.sessions.map((session) => reviews[session.session_id]);
      dataset.zip.file(
        "annotations/session_reviews.jsonl",
        `${ordered.map((review) => JSON.stringify(review)).join("\n")}\n`
      );
      dataset.zip.file(
        "annotations/session_reviews.json",
        JSON.stringify(ordered, null, 2)
      );
      const blob = await dataset.zip.generateAsync({ type: "blob" });
      downloadBlob(blob, `${dataset.manifest.dataset_id}-reviewed.zip`);
      setStatus("ready");
      setMessage("Reviewed zip downloaded.");
    } catch (exportError: unknown) {
      setStatus("error");
      setError(toErrorMessage(exportError));
      setMessage("Failed to export the reviewed zip.");
    }
  };

  useEffect(() => {
    if (!dataset || !selectedSession) {
      revokeAssetUrls();
      setSelectedAssets({ videoUrl: null, patchUrls: [] });
      return;
    }

    let cancelled = false;
    void (async () => {
      revokeAssetUrls();
      const nextAssets: SelectedAssets = { videoUrl: null, patchUrls: [] };

      if (selectedSession.clip_path) {
        const clipEntry = dataset.zip.file(selectedSession.clip_path);
        if (clipEntry) {
          const clipBlob = await clipEntry.async("blob");
          nextAssets.videoUrl = URL.createObjectURL(clipBlob);
          assetUrlsRef.current.push(nextAssets.videoUrl);
        }
      }

      const patchPaths = selectedSession.patch_paths.filter(Boolean);
      const previewPaths = patchPaths.length <= 6 ? patchPaths : patchPaths.filter((_, index) => index % Math.ceil(patchPaths.length / 6) === 0).slice(0, 6);
      for (const patchPath of previewPaths) {
        const patchEntry = dataset.zip.file(patchPath);
        if (!patchEntry) continue;
        const blob = await patchEntry.async("blob");
        const url = URL.createObjectURL(blob);
        assetUrlsRef.current.push(url);
        nextAssets.patchUrls.push(url);
      }

      if (!cancelled) setSelectedAssets(nextAssets);
    })();

    return () => {
      cancelled = true;
      revokeAssetUrls();
    };
  }, [dataset, selectedSession]);

  useEffect(() => {
    return () => {
      revokeAssetUrls();
    };
  }, []);

  const pressStartFrame = selectedReview?.press_start_frame ?? null;
  const pressEndFrame = selectedReview?.press_end_frame ?? null;
  const hasPressRange =
    selectedSession != null &&
    pressStartFrame != null &&
    pressEndFrame != null &&
    pressStartFrame <= pressEndFrame;
  const rangeLeftPct =
    selectedSession && hasPressRange
      ? ((pressStartFrame - 1) / selectedSession.frame_count) * 100
      : 0;
  const rangeWidthPct =
    selectedSession && hasPressRange
      ? ((pressEndFrame - pressStartFrame + 1) / selectedSession.frame_count) * 100
      : 0;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#dbeafe,0%,#eff6ff,30%,#ffffff,78%)] text-slate-900">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5">
        <div className="rounded-[28px] border border-sky-200/70 bg-white/88 p-5 shadow-[0_20px_80px_rgba(30,64,175,0.08)] backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                Pressure Dataset Annotator
              </div>
              <h1 className="mt-1 text-2xl font-semibold text-slate-900">
                Mark the pressed frame range in each sequence
              </h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Import a dataset zip from the collector, review each clip or patch strip, then mark
                exactly which frame interval contains the press. The exported JSONL includes
                press_start_frame and press_end_frame for training.
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                href="/collect-pressure"
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              >
                Open Collector
              </Link>
              <Link
                href="/"
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              >
                Back Home
              </Link>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700">
              Import Dataset Zip
              <input
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void loadDatasetFile(file);
                }}
              />
            </label>
            <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={showOnlyClipSessions}
                onChange={(event) => setShowOnlyClipSessions(event.target.checked)}
              />
              Only clip sessions
            </label>
            {dataset && (
              <>
                <button
                  type="button"
                  onClick={() => void exportReviewsJsonl()}
                  disabled={status === "exporting"}
                  className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-600"
                >
                  Download JSONL
                </button>
                <button
                  type="button"
                  onClick={() => void exportReviewedZip()}
                  disabled={status === "exporting"}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                >
                  Download Reviewed Zip
                </button>
              </>
            )}
          </div>
        </div>

        {dataset ? (
          <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Dataset</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">{dataset.manifest.dataset_id}</div>
                  <div className="mt-1 text-xs text-slate-500">{dataset.fileName}</div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Review Progress</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-900">
                    {reviewedCount} / {dataset.sessions.length}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">Marked sessions</div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
                no_press: {dataset.manifest.label_counts.no_press} · light: {dataset.manifest.label_counts.light} · firm: {dataset.manifest.label_counts.firm}
              </div>

              <div className="mt-4 max-h-[72vh] space-y-2 overflow-y-auto pr-1">
                {filteredSessions.map((session) => {
                  const touched = touchedReviews[session.session_id];
                  const review = reviews[session.session_id];
                  return (
                    <button
                      key={session.session_id}
                      type="button"
                      onClick={() => setSelectedSessionId(session.session_id)}
                      className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                        session.session_id === selectedSessionId
                          ? "border-sky-300 bg-sky-50"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-slate-900">{session.label}</div>
                        <div className="text-[11px] text-slate-500">{session.clip_saved ? "clip" : "seq"}</div>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {session.subject_id} · {session.frame_count} frames
                      </div>
                      <div className="mt-1 text-xs font-medium text-slate-600">
                        {formatPressRange(review)}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{new Date(session.started_at).toLocaleString()}</div>
                      <div className="mt-2 text-[11px]">
                        <span className={`rounded-full px-2 py-1 ${touched ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                          {touched ? "reviewed" : "pending"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
                <div className="text-sm font-semibold text-slate-900">Status</div>
                <div className="mt-3 space-y-2 text-sm text-slate-600">
                  <p>{message}</p>
                  {error && <p className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}</p>}
                </div>
              </div>

              {selectedSession && selectedReview ? (
                <>
                  <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">Session Viewer</div>
                        <div className="mt-1 text-sm text-slate-500">
                          {selectedSession.session_id} · {selectedSession.subject_id}
                        </div>
                      </div>
                      <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
                        {selectedSession.clip_saved ? "clip + sequence" : "sequence only"}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                      <div className="rounded-[24px] border border-slate-200 bg-slate-950 p-3 text-white">
                        {selectedAssets.videoUrl ? (
                          <video
                            ref={videoRef}
                            key={selectedAssets.videoUrl}
                            src={selectedAssets.videoUrl}
                            controls
                            loop
                            className="aspect-square w-full rounded-2xl border border-white/10 bg-black object-cover"
                          />
                        ) : (
                          <div className="flex aspect-square items-center justify-center rounded-2xl border border-white/10 bg-black/70 text-sm text-white/55">
                            No clip saved for this session
                          </div>
                        )}
                        <div className="mt-3 text-xs text-white/60">
                          Original label: {selectedSession.label} · {selectedSession.frame_count} frames
                        </div>
                      </div>

                      <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-3">
                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Patch Samples</div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          {selectedAssets.patchUrls.map((url, index) => (
                            <img
                              key={`${url}-${index}`}
                              src={url}
                              alt={`Patch ${index + 1}`}
                              className="aspect-square w-full rounded-xl border border-slate-200 object-cover"
                            />
                          ))}
                          {selectedAssets.patchUrls.length <= 0 && (
                            <div className="col-span-2 rounded-xl border border-slate-200 bg-white px-3 py-6 text-center text-sm text-slate-500">
                              No preview patches found in this session.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
                    <div className="text-sm font-semibold text-slate-900">Review Controls</div>
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">Reviewed Label</div>
                        <div className="flex flex-wrap gap-2">
                          {LABELS.map((option) => (
                            <button
                              key={option}
                              type="button"
                              onClick={() => updateSelectedReview({ reviewed_label: option })}
                              className={`rounded-full border px-4 py-2 text-sm font-medium ${
                                selectedReview.reviewed_label === option
                                  ? "border-sky-400 bg-sky-400 text-slate-950"
                                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                              }`}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-xs uppercase tracking-[0.18em] text-slate-500">
                              Press Frame Range
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              Mark the frame interval where the finger is actually pressing.
                            </div>
                          </div>
                          <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
                            {hasPressRange
                              ? `frames ${pressStartFrame}-${pressEndFrame}`
                              : "range not set"}
                          </div>
                        </div>

                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                              Start Frame
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={selectedSession.frame_count}
                              value={pressStartFrame ?? ""}
                              onChange={(event) => setPressStartFrame(event.target.value)}
                              placeholder="e.g. 8"
                              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-300"
                            />
                          </label>

                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                              End Frame
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={selectedSession.frame_count}
                              value={pressEndFrame ?? ""}
                              onChange={(event) => setPressEndFrame(event.target.value)}
                              placeholder={`1-${selectedSession.frame_count}`}
                              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-300"
                            />
                          </label>
                        </div>

                        <div className="mt-3 h-3 overflow-hidden rounded-full bg-white">
                          {hasPressRange && (
                            <div
                              className="h-full rounded-full bg-sky-400"
                              style={{
                                marginLeft: `${rangeLeftPct}%`,
                                width: `${rangeWidthPct}%`,
                              }}
                            />
                          )}
                        </div>
                        <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                          <span>1</span>
                          <span>{selectedSession.frame_count} frames</span>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setBoundaryFromVideo("start")}
                            disabled={!selectedAssets.videoUrl}
                            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Set Start From Video
                          </button>
                          <button
                            type="button"
                            onClick={() => setBoundaryFromVideo("end")}
                            disabled={!selectedAssets.videoUrl}
                            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Set End From Video
                          </button>
                          <button
                            type="button"
                            onClick={setWholePressRange}
                            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                          >
                            Whole Sequence
                          </button>
                          <button
                            type="button"
                            onClick={clearPressRange}
                            className="rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:border-rose-300 hover:bg-rose-50"
                          >
                            Clear Range
                          </button>
                        </div>
                      </div>

                      <div>
                        <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">Quality</div>
                        <div className="flex flex-wrap gap-2">
                          {QUALITIES.map((quality) => (
                            <button
                              key={quality}
                              type="button"
                              onClick={() => updateSelectedReview({ quality })}
                              className={`rounded-full border px-4 py-2 text-sm font-medium ${
                                selectedReview.quality === quality
                                  ? "border-emerald-400 bg-emerald-400 text-slate-950"
                                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                              }`}
                            >
                              {quality}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => updateSelectedReview({ keep: true })}
                          className={`rounded-full border px-4 py-2 text-sm font-medium ${
                            selectedReview.keep
                              ? "border-emerald-400 bg-emerald-400 text-slate-950"
                              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                          }`}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={() => updateSelectedReview({ keep: false })}
                          className={`rounded-full border px-4 py-2 text-sm font-medium ${
                            !selectedReview.keep
                              ? "border-rose-400 bg-rose-400 text-slate-950"
                              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                          }`}
                        >
                          Discard
                        </button>
                      </div>

                      <textarea
                        value={selectedReview.notes}
                        onChange={(event) => updateSelectedReview({ notes: event.target.value })}
                        rows={4}
                        placeholder="Notes about motion quality, finger stability, label confidence, or relabel reasons..."
                        className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-sky-300"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-10 text-center text-slate-500 shadow-[0_20px_80px_rgba(15,23,42,0.08)]">
                  Select a session to review its clip and patch sequence.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-[28px] border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center text-slate-500">
            Import a dataset zip from <span className="font-medium text-slate-700">/collect-pressure</span> to start annotating.
          </div>
        )}
      </div>
    </div>
  );
}
