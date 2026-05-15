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
      const mode = fields.mode === 'develop' || fields.mode?.[0] === 'develop' ? 'develop' : (fields.mode === 'check_status' || fields.mode?.[0] === 'check_status' ? 'check_status' : 'transcribe');

      // --- 階段一：語音轉種子 ---
      if (mode === 'transcribe') {
        const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
        if (!audioFile) throw new Error("找不到錄音檔案");
        
        const filePath = audioFile.filepath || audioFile.path;
        const fileStream = fs.createReadStream(filePath);
        
        const FormDataNode = await import('form-data').then(m => m.default);
        const fd = new FormDataNode();
        fd.append('file', fileStream, { filename: 'dream.webm' });
        fd.append('model', 'whisper-1');

        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, ...fd.getHeaders() },
          body: fd
        });
        const whisperResult = await whisperRes.json();
        const rawText = whisperResult.text || "";

        if (!rawText) throw new Error("語音識別失敗，請再試一次或大聲一點");

        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位精準的夢境分析師。請提取場景、情緒、人物、顏色、感受。語言需與輸入一致。" },
              { role: "user", content: `原始夢境：${rawText}。請回傳 JSON：{"seeds": {"scene": "", "mood": "", "character": "", "color": "", "feeling": ""}}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const chatData = await chatRes.json();
        const aiContent = JSON.parse(chatData.choices[0].message.content);
        return res.status(200).json({ success: true, rawTranscript: rawText, seeds: aiContent.seeds });

      } 
      
      // --- 階段二：使用 Kling AI 下單生成影片 ---
      else if (mode === 'develop') {
        const seedsRaw = Array.isArray(fields.seeds) ? fields.seeds[0] : fields.seeds;
        const seeds = typeof seedsRaw === 'string' ? JSON.parse(seedsRaw) : seedsRaw;
        
        // 1. 叫 GPT 寫出英文 Prompt
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

        // 2. 請求 Kling AI 下單
        const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${KLING_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "kling-v1",
            prompt: prompt,
            aspect_ratio: "9:16",
            duration: "5"
          })
        });
        const klingData = await klingRes.json();
        const taskId = klingData.data?.task_id;

        if (!taskId) {
          throw new Error(klingData.message || "Kling AI 下單失敗");
        }

        return res.status(200).json({ 
          success: true, 
          videoPrompt: prompt, 
          tags: tags,
          taskId: taskId
        });
      }

      // --- 階段三：檢查 Kling 影片好了沒 ---
      else if (mode === 'check_status') {
        const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
        
        const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${KLING_KEY}` }
        });
        const checkData = await checkRes.json();
        
        // Kling 成功通常會回傳 task_status: "SUCCESS" 並且附帶 video 網址
        const status = checkData.data?.task_status;
        const videoUrl = checkData.data?.task_result?.videos?.[0]?.url || "";

        return res.status(200).json({
          success: true,
          status: status, // "SUBMITTED", "PROCESSING", "SUCCESS", "FAILED"
          videoUrl: videoUrl
        });
      }

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
