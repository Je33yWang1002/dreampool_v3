import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';

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

      // --- 1. OpenAI Whisper (負責語音轉文字) ---
      const whisperData = new FormData();
      whisperData.append('file', fileStream, { filename: 'dream.webm' });
      whisperData.append('model', 'whisper-1');

      // 修正處：確保網址是純文字，沒有任何中括號或連結符號
      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...whisperData.getHeaders() 
        },
        body: whisperData
      });

      if (!whisperRes.ok) {
          const errorMsg = await whisperRes.text();
          throw new Error(`OpenAI Whisper API 錯誤: ${errorMsg}`);
      }

      const whisperResult = await whisperRes.json();
      const rawText = whisperResult.text || "（未能辨識出語音內容）";

      // --- 2. Google Gemini (負責劇本編導) ---
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ 
            parts: [{ text: `你是一位獲得奧斯卡獎的超現實主義導演。請將下方的夢境內容轉化為影片生成指令。
            要求：
            1. 必須包含光影、鏡頭運動（如慢動作、環繞鏡頭）描述。
            2. 回傳格式必須嚴格遵守 JSON：{"videoPrompt": "英文指令內容", "tags": ["標籤1", "標籤2"]}。
            
            夢境內容：${rawText}` }] 
          }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const geminiResult = await geminiRes.json();
      
      let structuredData = { videoPrompt: "無法生成指令", tags: ["未知"] };

      if (geminiResult.candidates && geminiResult.candidates[0].content.parts[0].text) {
          let rawGeminiText = geminiResult.candidates[0].content.parts[0].text;
          
          try {
              let cleanText = rawGeminiText
                                .replace(/```json/g, '')
                                .replace(/```/g, '')
                                .trim();
              structuredData = JSON.parse(cleanText);
          } catch (parseError) {
              structuredData.videoPrompt = rawGeminiText;
          }
      }

      return res.status(200).json({
        success: true,
        rawTranscript: rawText,
        videoPrompt: structuredData.videoPrompt,
        tags: structuredData.tags
      });

    } catch (error) {
      console.error("後端發生錯誤:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
