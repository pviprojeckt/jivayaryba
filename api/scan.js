// Vercel Serverless Function: POST /api/scan
// Keep GEMINI_API_KEY in Vercel Project Settings -> Environment Variables.
// Never place the key in index.html or any client-side JavaScript.

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_CATEGORIES = new Set([
  "Закуски", "Салаты", "Супы", "Горячее", "Пицца", "Десерты", "Бар"
]);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Разрешён только POST-запрос." });
  }

  const expectedOrigin = process.env.APP_ORIGIN;
  const requestOrigin = req.headers.origin;
  if (expectedOrigin && requestOrigin && requestOrigin !== expectedOrigin) {
    return res.status(403).json({ error: "Запрос с этого домена запрещён." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "На сервере не настроен GEMINI_API_KEY." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const imageBase64 = typeof body?.imageBase64 === "string"
      ? body.imageBase64.replace(/\s/g, "")
      : "";
    const mimeType = String(body?.mimeType || "").toLowerCase();

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return res.status(400).json({ error: "Поддерживаются только JPG, PNG и WEBP." });
    }
    if (!imageBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
      return res.status(400).json({ error: "Изображение отсутствует или имеет неверный формат." });
    }
    if (imageBase64.length > 4_200_000) {
      return res.status(413).json({ error: "Изображение слишком большое. Попробуйте фото меньшего размера." });
    }

    const prompt = `Ты профессиональный сканер ресторанного меню.
Извлеки все блюда и напитки с ценами с фотографии.
Правила:
1. Объединяй название, если оно занимает несколько строк. Не добавляй описание состава.
2. Если рядом с ценой есть вес/объём (например, "210 590"), первое число может быть граммами, а второе ценой. Выбирай именно цену.
3. Не выдумывай отсутствующие цены. Пропускай позиции, у которых цену невозможно уверенно прочитать.
4. Категория должна быть строго одной из: Закуски, Салаты, Супы, Горячее, Пицца, Десерты, Бар.
5. Верни только JSON-массив объектов с полями name (строка), price (целое число в рублях), cat (строка).`;

    const googleResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: imageBase64 } }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  price: { type: "INTEGER" },
                  cat: {
                    type: "STRING",
                    enum: ["Закуски", "Салаты", "Супы", "Горячее", "Пицца", "Десерты", "Бар"]
                  }
                },
                required: ["name", "price", "cat"]
              }
            }
          }
        })
      }
    );

    const googleData = await googleResponse.json().catch(() => ({}));
    if (!googleResponse.ok) {
      const message = googleData?.error?.message || `Gemini вернул HTTP ${googleResponse.status}`;
      const status = googleResponse.status === 429 ? 429 : 502;
      return res.status(status).json({ error: message });
    }

    const rawText = googleData?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!rawText) {
      return res.status(502).json({ error: "Gemini вернул пустой ответ. Попробуйте другое фото." });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    } catch {
      return res.status(502).json({ error: "Не удалось разобрать ответ ИИ. Повторите сканирование." });
    }

    const candidates = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(candidates)) {
      return res.status(502).json({ error: "ИИ вернул неожиданный формат данных." });
    }

    const items = [];
    const seen = new Set();
    for (const candidate of candidates.slice(0, 200)) {
      if (!candidate || typeof candidate !== "object") continue;
      const name = String(candidate.name || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const price = Number(candidate.price);
      const category = ALLOWED_CATEGORIES.has(candidate.cat) ? candidate.cat : "Горячее";
      if (!name || !Number.isInteger(price) || price <= 0 || price > 50000) continue;

      const key = `${name.toLocaleLowerCase("ru-RU")}|${price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name, price, cat: category });
    }

    if (items.length === 0) {
      return res.status(200).json({ items: [], message: "Не найдено позиций с уверенно распознанными ценами." });
    }

    return res.status(200).json({ items });
  } catch (error) {
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout
        ? "Сканирование заняло слишком много времени. Попробуйте фото меньшего размера."
        : "Внутренняя ошибка сканера. Попробуйте позже."
    });
  }
};


module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "5mb" }
  }
};
