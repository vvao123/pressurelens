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

  const { text, maxTopics = 20 } = body;

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
    "You are a topic extraction module used by a recommendation system. Your job is to extract topics from a full-page OCR text that the user might be interested in. You must return pure JSON only, with no explanations or extra text.";

  const userPrompt = `
Below is the OCR text for an entire screen/page. Based on its semantics, extract a list of topics that the user is likely interested in.
Requirements:
1. Each topic should be a short keyword/phrase/noun phrase (1–8 words or characters), as concise as possible.
2. Cover the core concepts, functions, product names, content themes, etc. that are useful for recall and ranking in a recommender system.
3. For each topic, assign a rough importance "weight" in the range 0–1, indicating how important this topic is on the page.
4. All output must be **valid JSON**, with no comments or extra text.
5. Topic "text" should preferably be in the same language as the OCR text when possible.

The JSON output MUST strictly follow:
{
  "topics": [
    {
      "text": "topic keyword or short phrase",
      "weight": 0.0,
      "category": "an optional coarse label such as: function, content, entity, action, other"
    }
  ]
}

Notes:
- Do not add any extra fields.
- The number of topics must not exceed ${maxTopics}.
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

    // content 本身应该已经是 JSON 字符串，但为了保证一定是 JSON，我们再 parse 一次
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // 如果解析失败，就包装成标准结构，避免前端直接崩溃
      parsed = { raw: content };
    }

    return new Response(JSON.stringify(parsed), {
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


