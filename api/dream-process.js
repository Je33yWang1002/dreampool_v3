import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';

export const config = {
  api: { bodyParser: false }, 
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "檔案解析失敗" });

    try {
      const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!audioFile) throw new Error("沒收到錄音檔案");
      
      const fileStream = fs.createReadStream(audioFile.filepath);

      // --- 1. OpenAI Whisper ---
      const FormDataNode = await import('form-data').then(m => m.default);
      const fd = new FormDataNode();
      fd.append('file', fileStream, { filename: 'dream.webm' });
      fd.append('model', 'whisper-1');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...fd.getHeaders() 
        },
        body: fd
      });

      const whisperResult = await whisperRes.json();
      const rawText = whisperResult.text || "";

      // --- 2. OpenAI GPT-4o (優化標籤與語言邏輯) ---
      const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { 
              role: "system", 
              content: `你是一位夢境分析師。請根據用戶錄音的語言進行分析：
              1. 如果錄音是中文，seeds 和 tags 必須全部使用繁體中文。
              2. 如果錄音是英文，seeds 和 tags 使用英文。
              3. tags 必須是「情緒或氛圍」相關的標籤（例如：詭異、焦慮、溫馨），不要放入物件名詞。
              4. prompt 則固定維持高品質英文影片指令。` 
            },
            { 
              role: "user", 
              content: `夢境內容：${rawText}。請回傳 JSON 格式：
              {
                "seeds": { "scene": "...", "mood": "...", "character": "...", "color": "...", "feeling": "...", "elements": "..." },
                "prompt": "...",
                "tags": ["情緒標籤1", "情緒標籤2", "情緒標籤3"]
              }` 
            }
          ],
          response_format: { type: "json_object" }
        })
      });

      const chatData = await chatRes.json();
      const aiContent = JSON.parse(chatData.choices[0].message.content);

      return res.status(200).json({
        success: true,
        rawTranscript: rawText,
        seeds: aiContent.seeds,
        videoPrompt: aiContent.prompt,
        tags: aiContent.tags
      });

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
