import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // --- 請在此處填入你的 Key ---
  const KLING_KEY = "sk-11c0717a842d43b4b2ed3977528f95f3";
  const OPENAI_KEY = "這裡請填入你的OpenAI金鑰"; // ⬅️ 這裡一定要填，不然第一步就掛了

  if (req.method === 'GET') {
    const { taskId } = req.query;
    if (!taskId) return res.status(400).json({ error: "Missing taskId" });
    try {
      const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
        headers: { 'Authorization': `Bearer ${KLING_KEY}` }
      });
      const checkData = await checkRes.json();
      const status = checkData.data?.task_status;
      const videoUrl = checkData.data?.task_result?.videos?.[0]?.url;
      return res.status(200).json({ 
        status: status === 'succeed' ? 'completed' : (status === 'failed' ? 'failed' : 'processing'),
        videoUrl: videoUrl || null 
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "解析失敗" });

    try {
      const isDevelopMode = fields.mode === 'develop' || fields.mode?.[0] === 'develop';

      if (!isDevelopMode) {
        const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
        const filePath = audioFile.filepath || audioFile.path;
        const fileStream = fs.createReadStream(filePath);
        
        const FormDataNode = await import('form-data').then(m => m.default);
        const fd = new FormDataNode();
        fd.append('file', fileStream, { filename: 'dream.webm' });
        fd.append('model', 'whisper-1');

        // 第一階段：Whisper
        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, ...fd.getHeaders() },
          body: fd
        });
        const whisperResult = await whisperRes.json();
        if (whisperResult.error) throw new Error("OpenAI Whisper 錯誤: " + whisperResult.error.message);
        
        const rawText = whisperResult.text || "";

        // 第二階段：GPT 提取種子
        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位精準的夢境分析師。請提取場景、情緒、人物、顏色、感受。" },
              { role: "user", content: `原始夢境：${rawText}。請回傳 JSON：{"seeds": {"scene": "", "mood": "", "character": "", "color": "", "feeling": ""}}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const chatData = await chatRes.json();
        const aiContent = JSON.parse(chatData.choices[0].message.content);
        return res.status(200).json({ success: true, rawTranscript: rawText, seeds: aiContent.seeds });

      } else {
        // 第三階段：Kling AI 生成
        const seeds = typeof fields.seeds === 'string' ? JSON.parse(fields.seeds) : JSON.parse(fields.seeds[0]);
        
        const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位電影編導。根據種子編寫一段高品質英文影片指令 (Video Prompt)，風格要超現實、夢幻，並生成三個情緒標籤。" },
              { role: "user", content: `種子：${JSON.stringify(seeds)}。請回傳 JSON：{"prompt": "...", "tags": ["", "", ""]}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const gptData = await gptRes.json();
        const { prompt, tags } = JSON.parse(gptData.choices[0].message.content);

        const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KLING_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "kling-v1",
            prompt: prompt,
            aspect_ratio: "9:16",
            duration: "5"
          })
        });
        const klingData = await klingRes.json();
        if (klingData.error) throw new Error("Kling AI 錯誤: " + klingData.error.message);

        return res.status(200).json({ 
          success: true, 
          videoPrompt: prompt, 
          tags: tags,
          taskId: klingData.data?.task_id
        });
      }
    } catch (error) {
      console.error("後端錯誤詳細內容:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
