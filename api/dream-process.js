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

      // --- 1. OpenAI Whisper ---
      const whisperData = new FormData();
      whisperData.append('file', fileStream, { filename: 'dream.webm' });
      whisperData.append('model', 'whisper-1');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...whisperData.getHeaders() 
        },
        body: whisperData
      });

      const whisperResult = await whisperRes.json();
      const rawText = whisperResult.text || "（未辨識到內容）";

      // --- 2. Google Gemini ---
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ 
            parts: [{ text: `你是一位影片導演。請針對夢境內容：「${rawText}」，寫一段 50 字內的英文影片描述指令 (Video Prompt)。直接輸出文字，不要任何格式。` }] 
          }]
        })
      });

      const geminiData = await geminiRes.json();
      
      // 超級保險抓取法：如果標準路徑沒資料，就顯示 API 回傳的原始訊息供偵錯
      let finalPrompt = "無法生成指令";
      
      try {
        if (geminiData.candidates && geminiData.candidates[0].content.parts[0].text) {
          finalPrompt = geminiData.candidates[0].content.parts[0].text.trim();
        } else if (geminiData.error) {
          finalPrompt = "API 錯誤訊息: " + geminiData.error.message;
        }
      } catch (e) {
        finalPrompt = "資料解析異常，請檢查 API Key 權限";
      }

      // --- 3. 回傳結果 ---
      return res.status(200).json({
        success: true,
        rawTranscript: rawText,
        videoPrompt: finalPrompt,
        tags: ["夢境分析", "自動生成"]
      });

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
