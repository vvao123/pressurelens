export const runtime = "nodejs";

export async function POST(req: Request) {
  const { text, level, image, streaming = false, prompt: providedPrompt, language = "en" } = await req.json();
  const baseUrl = (
    process.env.LOCAL_LLM_BASE_URL ||
    process.env.LLM_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const apiKey =
    process.env.LOCAL_LLM_API_KEY ||
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "";
  const model =
    (image ? process.env.LOCAL_LLM_VISION_MODEL : "") ||
    process.env.LOCAL_LLM_MODEL ||
    process.env.LLM_MODEL ||
    "gpt-4o-mini";

  if (!apiKey && baseUrl.includes("api.openai.com")) {
    return new Response(JSON.stringify({ error: "OpenAI API key not configured." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Log the received image data for debugging
  console.log('[LLM API] Received image data:', image ? 'Yes' : 'No');
  console.log('[LLM API] Streaming mode:', streaming);

  const prompt = (typeof providedPrompt === "string" && providedPrompt.trim())
    ? providedPrompt.trim()
    : level === "light"
    ? `Please define or explain in one sentence: "${text}"`
    : level === "medium"
    ? `Please explain in one paragraph (3-5 sentences) clearly: "${text}", including its meaning and basic usage.`
    : `Please explain in detail: "${text}", including:
1. Detailed definition and meaning
2. Main usage and application scenarios  
3. Related concepts or terms
4. Practical suggestions or notes
5. If applicable, provide further learning direction

The content must be accurate and practical.`;

  // Prepare messages for GPT
  const messages = [];
  
  if (image) {
    // If we have an image, use GPT-4 Vision to analyze both text and image
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `I have captured an image and also extracted this text from it using OCR: "${text}". The OCR text could be inaccurate; if so, ignore it and rely on the image. ${prompt}\n\nPlease answer in ${language === "zh" ? "Chinese" : "English"}.`
        },
        {
          type: "image_url",
          image_url: {
            url: image
          }
        }
      ]
    });
  } else {
    // If no image, just use the text
    messages.push({ role: "user", content: prompt });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: streaming,
      messages: messages
    })
  });

  if (!r.ok) {
    const errorText = await r.text().catch(() => "");
    return new Response(
      JSON.stringify({
        error: "Failed to call chat completions API.",
        status: r.status,
        detail: errorText,
        baseUrl,
        model,
      }),
      {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (streaming) {
    // Return streaming response
    return new Response(r.body, {
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "text/plain; charset=utf-8",
      }
    });
  } else {
    // Return non-streaming JSON response
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || "No response";
    
    return new Response(JSON.stringify({ content }), {
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
}
