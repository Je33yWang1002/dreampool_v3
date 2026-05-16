import { IncomingForm } from 'formidable';
import nodeFetch from 'node-fetch';

// 告訴 Vercel 不要自己去解析表單，交給 formidable 處理
export const config = { api: { bodyParser: false } };

// 最新 Kling 官方指定的海外網址
const BASE_URL = "https://api-singapore.klingai.com";

// 你的個人專屬金鑰 (直接填入你提供的 Kling API_KEY)
// 註：根據官方最新文件，如果是使用 Bearer 直接認證，通常使用提供的 API_KEY。
// 這裡我們直接使用您提供的 Access Key 作為 Bearer Token 進行簡化連接
const KLING_API_KEY = "ADJJQPbEEDNGEACYA9e3Cm9MbeGgFbNy"; 

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(455).json({ success: false, error: '請使用 POST 請求' });
  }

  const form = new IncomingForm();
  
  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ success: false, error: '解析表單失敗' });
    }

    const mode = Array.isArray(fields.mode) ? fields.mode[0] : fields.mode;

    // ---------------- 階段一：送出文字，叫 Kling 開始做影片 ----------------
    if (mode === 'create_task') {
      const prompt = Array.isArray(fields.prompt) ? fields.prompt[0] : fields.prompt;
      
      if (!prompt) {
        return res.status(400).json({ success: false, error: '請輸入夢境描述' });
      }

      try {
        // 呼叫 Kling 文字生成影片的最新網址
        const response = await nodeFetch(`${BASE_URL}/v1/videos/text2video`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${KLING_API_KEY}`
          },
          body: JSON.stringify({
            model: "kling-v2.6-pro", // 使用你文件中提到的 2.6 Pro 模型
            prompt: prompt,
            duration: 5,            // 影片長度 5 秒
            aspect_ratio: "9:16",   // 配合你需求文件的直式 9:16 比例
            mode: "professional"    // 專業模式
          })
        });

        const resData = await response.json();

        // 如果 Kling 說失敗
        if (!response.ok || resData.code !== 0) {
          return res.status(500).json({ 
            success: false, 
            error: resData.message || `Kling 平台回應錯誤: ${resData.code}` 
          });
        }

        // 成功的話，會拿到一個 task_id (任務號碼牌)
        const taskId = resData.task_id || resData.data?.task_id;
        
        return res.status(200).json({
          success: true,
          taskId: taskId
        });

      } catch (error) {
        return res.status(500).json({ success: false, error: '階段一發生錯誤: ' + error.message });
      }
    }

    // ---------------- 階段二：拿著號碼牌，定時查詢影片好了沒 ----------------
    else if (mode === 'check_status') {
      const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
      if (!taskId) {
        return res.status(400).json({ success: false, error: '缺少任務 ID (taskId)' });
      }

      try {
        // 呼叫 Kling 查詢狀態的最新網址
        const checkRes = await nodeFetch(`${BASE_URL}/v1/videos/${taskId}`, {
          method: 'GET',
          headers: { 
            'Authorization': `Bearer ${KLING_API_KEY}` 
          }
        });
        
        const checkData = await checkRes.json();

        if (!checkRes.ok) {
          return res.status(500).json({ success: false, error: '查詢狀態伺服器失敗' });
        }

        // 依據最新文件：回傳格式中狀態為 status，影片為 video_url
        // 這裡做個保險，相容舊版與新版的欄位名稱
        const currentStatus = checkData.status || checkData.data?.task_status;
        let videoUrl = checkData.video_url || checkData.data?.task_result?.videos[0]?.url || "";

        // 統一將狀態轉換成大寫方便前端判斷
        let statusUpper = String(currentStatus).toUpperCase();
        if (statusUpper === 'SUCCEED') statusUpper = 'SUCCESS'; // 修正新舊版文字差異

        return res.status(200).json({
          success: true,
          status: statusUpper,
          videoUrl: videoUrl
        });

      } catch (error) {
        return res.status(500).json({ success: false, error: '階段二查詢發生錯誤: ' + error.message });
      }
    }
  });
}
