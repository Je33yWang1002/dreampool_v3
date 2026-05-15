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
      const isDevelopMode = fields.mode === 'develop' || fields.mode?.[0] === 'develop';
      const KLING_KEY = "sk-11c0717a842d43b4b2ed3977528f95f3";

      // --- 階段一：語音轉種子 ---
      if (!isDevelopMode) {
        const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
        const filePath = audioFile.filepath || audioFile.path;
        const fileStream = fs.createReadStream(filePath);
        
        const FormDataNode = await import('form-data').then(m => m.default);
        const fd = new FormDataNode();
        fd.append('file', fileStream, { filename: 'dream.webm' });
        fd.append('model', 'whisper-1');

        // 1. 語音轉文字
        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...fd.getHeaders() },
          body: fd
        });
        const whisperResult = await whisperRes.json();
        const rawText = whisperResult.text || "";

        // 2. 文本分析 (嚴格指定 JSON 格式)
        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { 
                role: "system", 
                content: "你是一位夢境分析師。請提取：場景(scene)、情緒(mood)、人物(character)、顏色(color)、感受(feeling)。請用繁體中文回答，並嚴格遵守 JSON 結構。" 
              },
              { 
                role: "user", 
                content: `內容：${rawText}。回傳格式：{"seeds": {"scene": "", "mood": "", "character": "", "color": "", "feeling": ""}}` 
              }
            ],
            response_format: { type: "json_object" }
          })
        });
        const chatData = await chatRes.json();
        const aiContent = JSON.parse(chatData.choices[0].message.content);
        
        return res.status(200).json({ success: true, rawTranscript: rawText, seeds: aiContent.seeds });

      } else {
        // --- 階段二：Kling AI 生成 ---
        const seeds = typeof fields.seeds === 'string' ? JSON.parse(fields.seeds) : JSON.parse(fields.seeds[0]);
        
        // 1. 生成 Video Prompt
        const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位電影編導。根據種子寫出一段高品質英文 Video Prompt，要超現實，並回傳三個標籤。" },
              { role: "user", content: `種子：${JSON.stringify(seeds)}。格式：{"prompt": "", "tags": ["", "", ""]}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const gptData = await gptRes.json();
        const { prompt, tags } = JSON.parse(gptData.choices[0].message.content);

        // 2. 提交任務給 Kling
        const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KLING_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: "kling-v1", prompt: prompt, aspect_ratio: "9:16", duration: "5" })
        });
        const klingData = await klingRes.json();
        const taskId = klingData.data?.task_id;

        if (!taskId) throw new Error("Kling 任務提交失敗");

        // 3. 輪詢領取影片 (Polling)
        let videoUrl = "";
        for (let i = 0; i < 24; i++) { // 每 5 秒檢查一次，最多等 2 分鐘
          await new Promise(r => setTimeout(r, 5000));
          const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
            headers: { 'Authorization': `Bearer ${KLING_KEY}` }
          });
          const checkData = await checkRes.json();
          if (checkData.data?.task_status === 'succeed') {
            videoUrl = checkData.data.video_list[0].url;
            break;
          }
          if (checkData.data?.task_status === 'failed') throw new Error("影片生成失敗");
        }

        return res.status(200).json({ 
          success: true, 
          videoPrompt: prompt, 
          tags: tags,
          videoUrl: videoUrl
        });
      }
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
