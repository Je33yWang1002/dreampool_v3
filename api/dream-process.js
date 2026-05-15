import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });
  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "檔案解析失敗" });

    try {
      const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
      const fileStream = fs.createReadStream(audioFile.filepath);

      // --- 1. OpenAI Whisper ---
      const FormDataNode = await import('form-data').then(m => m.default);
      const fd = new FormDataNode();
      fd.append('file', fileStream, { filename: 'dream.webm' });
      fd.append('model', 'whisper-1');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...fd.getHeaders() },
        body: fd
      });
      const whisperResult = await whisperRes.json();
      const rawText = whisperResult.text || "";

      // --- 2. OpenAI GPT-4o (嚴格提取邏輯) ---
      const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { 
              role: "system", 
              content: `你是一位精準的夢境分析師。請僅根據「原始夢境」中提及的內容提取資訊。
              - 語音是中文就用繁體中文，英文就用英文。
              - tags 僅提取「情緒」相關詞彙，語言需與語音一致。
              - 如果語音中完全沒提到某個種子類別（場景、情緒、人物、顏色、感受），該欄位請回傳空字串 ""。` 
            },
            { 
              role: "user", 
              content: `原始夢境：${rawText}。請回傳 JSON：
              {
                "seeds": { "scene": "", "mood": "", "character": "", "color": "", "feeling": "" },
                "prompt": "高品質英文影片指令",
                "tags": []
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
