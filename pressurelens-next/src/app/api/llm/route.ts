export const runtime = "edge";

export async function POST(req: Request) {
  const { text, level } = await req.json();
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  const prompt = level === "light"
    ? `请用一句话简单定义或解释："${text}"`
    : level === "medium"
    ? `请用一段话（2-3句）清楚解释："${text}"，包括其含义和基本用途。`
    : `请详细解释："${text}"，包括：
1. 详细定义和含义
2. 主要用途和应用场景  
3. 相关概念或术语
4. 实用建议或注意事项
5. 如果适用，提供进一步学习的方向

请用中文回答，内容要准确且实用。`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      stream: false,  // 关闭流式
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await r.json();
  
  // 只返回content部分
  const content = data.choices?.[0]?.message?.content || "No response";
  
  return new Response(JSON.stringify({ content }), {
    headers: {
      "Content-Type": "application/json"
    }
  });
}
