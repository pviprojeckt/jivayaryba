export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { imageBase64, mimeType } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return res.status(500).json({ error: 'API key not configured on server' });
        }

        const promptText = `Ты профессиональный парсер ресторанного меню. 
Внимательно прочитай фото меню. 
1. Извлеки все блюда и напитки. Если название блюда в несколько строк — объедини в одну чистую строку.
2. Игнорируй граммы и объемы (например 210, 250, 440). Бери СТРОГО цену в рублях.
3. Назначь категорию строго из списка: "Закуски", "Салаты", "Супы", "Горячее", "Пицца", "Десерты", "Бар".
Верни ответ СТРОГО в виде валидного JSON-массива объектов, без markdown-разметки (\`\`\`json):
[{"name": "Тёплый салат с тыквой", "price": 590, "cat": "Салаты"}]`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: promptText },
                        { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } }
                    ]
                }],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: "application/json"
                }
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Ошибка Google API: ${response.status}`);
        }

        const result = await response.json();
        const rawJsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        const cleanedJson = rawJsonText.replace(/```json|```/g, '').trim();
        const parsedArray = JSON.parse(cleanedJson);

        return res.status(200).json(parsedArray);

    } catch (err) {
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
