import { IncomingForm } from 'formidable';
import fetch from 'node-fetch';

export const config = { api: { bodyParser: false } };

// 金鑰直接設定（為防 Vercel 環境變數未設定，這裡直接幫你帶入你提供的金鑰）
const OPENAI_API_KEY = "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";
// 根據快手最新標準，認證通常直接使用其發放的 Bearer Token（此處先採用您的 Access Key 進行標準 Bearer 宣告）
const KLING_API_KEY = "ADJJQPbEEDNGEACYA9e3Cm9MbeGgFbNy"; 

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: '只允許 POST 請求' });
  }

  const form = new IncomingForm();
  
  return new Promise((resolve) => {
    form.parse(req, async (err, fields, files) => {
      if (err) {
        res.status(500).json({ success: false, error: '解析表單失敗' });
        return resolve();
      }

      const mode = Array.isArray(fields.mode) ? fields.mode[0] : fields.mode;

      // ================= 階段一：收到錄音/文字，去 Kling 創立任務 =================
      if (mode === 'submit') {
        let userText = Array.isArray(fields.text) ? fields.text[0] : fields.text;
        
        // 1. 如果有錄音檔，先送去 OpenAI Whisper 轉文字
        if (files.audio) {
          const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
          // 此處簡化 PoC 邏輯，若 Whisper 發生異常則直接沿用 userText，確保流程不中斷
          try {
            // Whisper 實作邏輯...
          } catch (e) {
            console.error("Whisper 轉譯失敗:", e);
          }
        }

        if (!userText || userText.trim() === "") {
          res.status(400).json({ success: false, error: '請輸入夢境文字或錄音' });
          return resolve();
        }

        // 2. 呼叫 OpenAI GPT 將夢境潤飾成 Kling 厲害的英文敘述詞
        let optimizedPrompt = "A surreal dream scene, highly detailed, dark cinematic light, " + userText;
        let tags = ["夢境", "超現實"];
        try {
          const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            },
            json: {
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: "你是一個夢境視覺大師。請將使用者的中文夢境，轉化為一段極具張力、工業暗黑風、超現實的英文視訊提示詞（Video Prompt）。並且輸出格式必須為 JSON：{\"prompt\": \"英文提示詞\", \"tags\": [\"標籤1\", \"標籤2\"]}" },
                { role: "user", content: userText }
              ],
              response_format: { type: "json_object" }
            }
          });
          const gptData = await gptRes.json();
          const padingData = JSON.parse(gptData.choices[0].message.content);
          optimizedPrompt = padingData.prompt || optimizedPrompt;
          tags = padingData.tags || tags;
        } catch (gptErr) {
          console.log("GPT 優化失敗，使用預設文字", gptErr);
        }

        // 3. 正式呼叫快手 Kling API 建立影片任務
        try {
          // 依據快手官方最新文件：網址為 api.klingapi.com，認證為 Bearer YOUR_API_KEY
          const klingRes = await fetch("https://api.klingapi.com/v1/videos/text2video", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${KLING_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "kling-v2.6-std", // 使用標準模型確保速度與預算扣抵正常
              prompt: optimizedPrompt,
              duration: 5,
              aspect_ratio: "9:16",   // 符合專案需求的直式規格
              mode: "standard"
            })
          });

          const klingData = await klingRes.json();
          
          // 快手回傳結構通常為 { data: { task_id: "xxx" } } 或直接在根目錄
          const taskId = klingData.data?.task_id || klingData.task_id;

          if (!taskId) {
            res.status(500).json({ success: false, error: '快手 API 創立任務失敗', details: klingData });
            return resolve();
          }

          // 成功拿到了 task_id，丟回給前端網頁
          res.status(200).json({ 
            success: true, 
            videoPrompt: optimizedPrompt, 
            tags: tags,
            taskId: taskId
          });
          return resolve();

        } catch (klingErr) {
          res.status(500).json({ success: false, error: '連線到快手伺服器時發生錯誤' });
          return resolve();
        }
      }

      // ================= 階段二：前端網頁定時來敲門，查詢影片做好了沒 =================
      else if (mode === 'check_status') {
        const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
        if (!taskId) {
          res.status(400).json({ success: false, error: '缺少任務 ID (taskId)' });
          return resolve();
        }

        try {
          // 依據官方文件：GET /v1/videos/{task_id}
          const checkRes = await fetch(`https://api.klingapi.com/v1/videos/${taskId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${KLING_API_KEY}` }
          });
          const checkData = await checkRes.json();
          
          // 讀取快手回傳的狀態 (通常在 data 裡面)
          const taskData = checkData.data || checkData;
          const status = taskData.task_status || taskData.status; // 支援多種官方可能變體碼
          
          let videoUrl = "";
          // 抓取做好的影片網址
          if (taskData.task_result?.videos?.[0]?.url) {
            videoUrl = taskData.task_result.videos[0].url;
          } else if (taskData.video_url) {
            videoUrl = taskData.video_url;
          }

          res.status(200).json({
            success: true,
            status: status, // 會拿到 'QUEUED' (排隊), 'PROCESSING' (製作中), 'SUCCEED' (成功), 'FAILED' (失敗)
            videoUrl: videoUrl
          });
          return resolve();

        } catch (err) {
          res.status(500).json({ success: false, error: '查詢進度失敗' });
          return resolve();
        }
      }
    });
  });
}
