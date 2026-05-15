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

      // --- 1. OpenAI Whisper (語音轉文字) ---
      const whisperData = new FormData();
      // 這裡需要手動引入或是確保環境支援，因為原本是用外部套件，保持邏輯一致
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
      const rawText = whisperResult.text || "（未辨識到內容）";

      // --- 2. OpenAI GPT-4o (生成影片指令與標籤) ---
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
              content: "你是一位夢境分析師與影片導演。請將夢境描述轉化為一段英文影片指令 (Video Prompt)，並提取3個情緒標籤。" 
            },
            { 
              role: "user", 
              content: `夢境內容：${rawText}。請回傳 JSON 格式：{"prompt": "英文描述", "tags": ["標籤1", "標籤2", "標籤3"]}` 
            }
          ],
          response_format: { type: "json_object" }
        })
      });

      const chatData = await chatRes.json();
      const aiContent = JSON.parse(chatData.choices[0].message.content);

      // --- 3. 回傳結果 ---
      return res.status(200).json({
        success: true,
        rawTranscript: rawText,
        videoPrompt: aiContent.prompt,
        tags: aiContent.tags
      });

    } catch (error) {
      console.error("OpenAI Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
