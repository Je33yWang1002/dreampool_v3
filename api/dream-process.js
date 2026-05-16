import { IncomingForm } from 'formidable';
import fetch from 'node-fetch';

export const config = { api: { bodyParser: false } };

// 這裡直接幫你把剛剛提供的 Kling 最新金鑰組合好 (Access_Key.Secret_Key)
const KLING_FINAL_KEY = "ADJJQPbEEDNGEACYA9e3Cm9MbeGgFbNy.8DJ3ghrHk9ELeaeNJGRL8ChCknepH4E9";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: '只支援 POST 請求' });
  }

  const form = new IncomingForm();
  form.parse(req, async (err, fields) => {
    if (err) {
      return res.status(500).json({ success: false, error: '解析表單失敗' });
    }

    // 取得前端傳過來的模式：是「第一階段：建立任務」還是「第二階段：檢查狀態」
    const mode = Array.isArray(fields.mode) ? fields.mode[0] : fields.mode;

    // ---------------- 階段一：建立影片生成任務 ----------------
    if (mode === 'create_task') {
      const prompt = Array.isArray(fields.prompt) ? fields.prompt[0] : fields.prompt;
      const tags = Array.isArray(fields.tags) ? fields.tags[0] : fields.tags;

      if (!prompt) {
        return res.status(400).json({ success: false, error: '缺少夢境描述詞 (prompt)' });
      }

      try {
        // 依照 Kling 最新文件發送請求
        const response = await fetch('https://api.klingapi.com/v1/videos/text2video', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${KLING_FINAL_KEY}`
          },
          body: JSON.stringify({
            model: "kling-v2.6-std", // 採用最新 2.6 標準版模型
            prompt: prompt,
            duration: 5,            // 生成 5 秒影片
            aspect_ratio: "9:16"    // 符合你 PoC 需求的直式比例
          })
        });

        const data = await response.json();

        // 如果 Kling 回報錯誤
        if (!response.ok || data.code !== 0) {
          return res.status(500).json({ 
            success: false, 
            error: data.message || 'Kling API 回傳錯誤',
            detail: data
          });
        }

        // 順利拿到任務 ID
        const taskId = data.data?.task_id;
        if (!taskId) {
          return res.status(500).json({ success: false, error: '無法取得 Kling 任務 ID' });
        }

        return res.status(200).json({ 
          success: true, 
          videoPrompt: prompt, 
          tags: tags,
          taskId: taskId
        });

      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    }

    // ---------------- 階段二：定時查詢影片到底好了沒 ----------------
    else if (mode === 'check_status') {
      const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
      if (!taskId) {
        return res.status(400).json({ success: false, error: '缺少任務 ID (taskId)' });
      }

      try {
        // 依照 Kling 最新文件查詢單一任務進度
        const checkRes = await fetch(`https://api.klingapi.com/v1/videos/text2video/${taskId}`, {
          method: 'GET',
          headers: { 
            'Authorization': `Bearer ${KLING_FINAL_KEY}` 
          }
        });
        
        const checkData = await checkRes.json();

        if (!checkRes.ok || checkData.code !== 0) {
          return res.status(500).json({ success: false, error: checkData.message || '查詢狀態失敗' });
        }

        // 讀取 Kling 的任務狀態 (大寫)
        const taskStatus = checkData.data?.task_status; 
        let videoUrl = "";

        // 如果成功了，抓取官方結構裡的影片網址
        if (taskStatus === 'SUCCEED' && checkData.data?.task_result?.videos) {
          videoUrl = checkData.data.task_result.videos[0]?.url || "";
        }

        return res.status(200).json({
          success: true,
          status: taskStatus, // 會是 'QUEUED', 'PROCESSING', 'SUCCEED', 'FAILED'
          videoUrl: videoUrl
        });

      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    }

    else {
      return res.status(400).json({ success: false, error: '未知的操作模式' });
    }
  });
}
