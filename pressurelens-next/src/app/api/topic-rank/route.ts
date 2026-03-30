import type { RankRequest } from "../../../lib/topicRanking/types";

export const runtime = "nodejs";

const DEFAULT_RANKER_BASE_URL = "http://172.25.227.74:8000";
// const DEFAULT_RANKER_BASE_URL = "http://172.0.0.1:8000";
export async function POST(req: Request) {
  let body: RankRequest;

  try {
    body = (await req.json()) as RankRequest;
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Invalid JSON body",
        detail: String(error),
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const pageTopics = Array.isArray(body.pageTopics) ? body.pageTopics : [];
  const pointerWindow = Array.isArray(body.pointerWindow) ? body.pointerWindow : [];

  if (pageTopics.length === 0) {
    return new Response(
      JSON.stringify({ error: "`pageTopics` is required and cannot be empty." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (pointerWindow.length === 0) {
    return new Response(
      JSON.stringify({ error: "`pointerWindow` is required and cannot be empty." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const baseUrl =
    process.env.TOPIC_RANKER_BASE_URL?.trim() || DEFAULT_RANKER_BASE_URL;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const upstream = await fetch(`${baseUrl}/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await upstream.text();

    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const message =
      (error as Error).name === "AbortError"
        ? "Topic rank request timed out."
        : "Failed to reach topic rank service.";

    console.error("[TopicRank API] proxy error", error);

    return new Response(
      JSON.stringify({
        error: message,
        detail: String(error),
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
