export const runtime = "edge";

export async function POST(req: Request) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OpenAI API key not configured." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const form = await req.formData();
    const audio = form.get("audio");

    if (!(audio instanceof File)) {
      return new Response(
        JSON.stringify({ error: "`audio` file is required in form-data." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const fd = new FormData();
    fd.append("file", audio);
    fd.append("model", "whisper-1");
    // Use verbose_json so we can get segment timestamps to estimate wake word timing
    fd.append("response_format", "verbose_json");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: fd,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("[Voice STT] Upstream error:", r.status, errText);
      return new Response(
        JSON.stringify({
          error: "Failed to call OpenAI audio transcription API.",
          status: r.status,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await r.json();
    const transcript: string = data.text || "";
    const segments = Array.isArray(data.segments) ? data.segments : undefined;

    return new Response(JSON.stringify({ transcript, segments }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[Voice STT] Unexpected error:", e);
    return new Response(
      JSON.stringify({
        error: "Unexpected error when transcribing audio.",
        detail: String(e),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}


