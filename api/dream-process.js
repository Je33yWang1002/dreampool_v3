import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "解析失敗" });

    try {
      // 判斷目前是「語音分析」還是「夢境沖洗 (文字重新生成)」
      const isDevelopMode = fields.mode === 'develop';

      if (!isDevelopMode) {
        // --- 階段一：語音轉種子 ---
        const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
        const fileStream = fs.createReadStream(audioFile.filepath);

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

        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位精準的夢境分析師。請僅根據原始夢境中提及的內容提取資訊，未提到的欄位回傳空字串。" },
              { role: "user", content: `原始夢境：${rawText}。請回傳 JSON：{"seeds": {"scene": "", "mood": "", "character": "", "color": "", "feeling": ""}}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const chatData = await chatRes.json();
        const aiContent = JSON.parse(chatData.choices[0].message.content);

        return res.status(200).json({ success: true, rawTranscript: rawText, seeds: aiContent.seeds });

      } else {
        // --- 階段二：夢境沖洗 (根據種子生成 Prompt) ---
        const seeds = JSON.parse(fields.seeds);
        const lang = fields.lang || "zh-TW";

        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位視覺編導。請根據提供的夢境種子，編寫一段高品質的英文影片指令 (Video Prompt)，並提取 3 個符合原語言的情緒標籤。" },
              { role: "user", content: `種子內容：${JSON.stringify(seeds)}。請回傳 JSON：{"prompt": "...", "tags": ["", "", ""]}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const chatData = await chatRes.json();
        const aiContent = JSON.parse(chatData.choices[0].message.content);

        return res.status(200).json({ success: true, videoPrompt: aiContent.prompt, tags: aiContent.tags });
      }
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
