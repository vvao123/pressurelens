export const runtime = "edge";

type TopicsRequestBody = {
  text: string;
  maxTopics?: number;
};

export async function POST(req: Request) {
  let body: TopicsRequestBody;

  try {
    body = await req.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body", detail: String(e) }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const { text, maxTopics = 60 } = body;

  if (!text || typeof text !== "string") {
    return new Response(
      JSON.stringify({ error: "`text` is required and must be a string." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OpenAI API key not configured." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const systemPrompt =
    "You are a keyword/topic extraction module used by a recommendation system. You must return pure JSON only, with no explanations or extra text.";

  const userPrompt = `
Below is the OCR text for an entire screen/page. Extract as MANY interesting keywords/phrases as possible that may capture the reader's interest.
Requirements:
1. Output items are short keywords/phrases/noun phrases (1–8 words/chars).
2. Include BOTH high-level topics AND concrete terms that may trigger interest: features, functions, entities, acronyms, product names, technical terms, proper nouns, commands, metrics, unusual phrases.
3. Prefer items that appear in the OCR text (be robust to OCR noise).
4. De-duplicate aggressively (case-insensitive, singular/plural variants).
5. Do NOT output weights or categories; just output the strings.
6. All output must be valid JSON, no extra text.

The JSON output MUST strictly follow:
{
  "topics": ["keyword or short phrase", "another keyword", "..."]
}

Notes:
- Do not add any extra fields.
- The number of topics must not exceed ${maxTopics}.
- Prefer producing MORE items up to the limit; avoid trivial stop-words.
- Only return JSON.

Here is the OCR text (may contain noise or errors, be robust when extracting topics):
"""${text}"""
`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      const errorText = await r.text().catch(() => "");
      console.error("[Topics API] Upstream error:", r.status, errorText);
      return new Response(
        JSON.stringify({
          error: "Failed to call OpenAI chat completions API.",
          status: r.status,
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || typeof content !== "string") {
      return new Response(
        JSON.stringify({
          error: "Empty response from OpenAI.",
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // content should already be a JSON string, but parse again to be safe
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // If parsing fails, wrap into a standard structure to avoid frontend crashes
      parsed = { raw: content };
    }

    // Normalize output to the minimal contract:
    //   { topics: string[] }
    const rawTopics = Array.isArray((parsed as any)?.topics) ? (parsed as any).topics : [];
    const topics = rawTopics
      .map((t: any) => {
        if (typeof t === "string") return t.trim();
        if (t && typeof t === "object" && typeof t.text === "string") return t.text.trim();
        return "";
      })
      .filter(Boolean)
      .slice(0, maxTopics);

    return new Response(JSON.stringify({ topics }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[Topics API] Unexpected error:", e);
    return new Response(
      JSON.stringify({
        error: "Unexpected error when generating topics.",
        detail: String(e),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}


