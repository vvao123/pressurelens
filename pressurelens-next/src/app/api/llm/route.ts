export const runtime = "edge";

export async function POST(req: Request) {
  const { text, level, image, streaming = false, focusHint } = await req.json();
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // Log the received image data for debugging
  console.log('[LLM API] Received image data:', image ? 'Yes' : 'No');
  console.log('[LLM API] Streaming mode:', streaming);
  console.log('[LLM API] Level:', level);


  // In finger mode (image + focusHint), the goal is to explain
  // what the user is pointing at in the screenshot, not just the raw text.
  const isFingerMode = !!image && !!focusHint;

  const prompt = isFingerMode
    ? (
      level === "light"
        ? `Please briefly explain what the user is pointing at in the image. If there is readable text at that location, first transcribe it and then explain its meaning in 1-2 sentences. If there is no important text, describe the visual content in that area in 1-2 sentences.`
        : level === "medium"
        ? `Please clearly explain what the user is pointing at in the image in one short paragraph (3-5 sentences). If there is readable text at that location, first transcribe it and then explain its meaning and context. If there is no important text, describe the visual content in that area and its possible meaning or function.`
        : `Please explain in detail what the user is pointing at in the image, including:
1. If there is readable text at that location, first transcribe it and give a detailed explanation of its meaning and context
2. If there is no important text, describe in detail the visual content in that area and its possible meaning or function
3. Any relevant background knowledge that helps a non-expert understand
4. Practical suggestions or notes if applicable

The explanation must be accurate and easy to understand for beginners.`
    )
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

The content must be accurate and practical.

`;

  // Prepare messages for GPT
  const messages = [];
  const focusText = focusHint
    ? `${focusHint}.`
    : "";
  
  if (image) {
    // If we have an image, use GPT-4 Vision to analyze both text and image
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `I have captured an image,  Please analyze the image.${prompt} Please answer in English.${focusText} `
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

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: image ? "gpt-4o" : "gpt-4o-mini", // Use GPT-4o for vision capabilities
      stream: streaming,
      messages: messages
    })
  });

  if (streaming) {
    // Return streaming response
    return new Response(r.body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked"
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
