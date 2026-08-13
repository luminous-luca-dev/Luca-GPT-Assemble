// supabase/functions/push-notification/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ONESIGNAL_APP_ID = Deno.env.get('ONESIGNAL_APP_ID')!
const ONESIGNAL_REST_API_KEY = Deno.env.get('ONESIGNAL_REST_API_KEY')!

serve(async (req) => {
    try {
        const { record } = await req.json()
        console.log("【1. Webhook受信】送信元データ:", record)

        // メッセージの送信者が 'luca'（管理者）以外なら、通知は送らず終了
        if (record?.sender !== 'luca') {
            console.log(`【スキップ】送信者が 'luca' ではありません (sender: ${record?.sender})`)
            return new Response("Not an admin message", { status: 200 })
        }

        // データベース接続用のクライアントを準備
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        )

        // threadsテーブルから、この会話スレッドに紐づく相手のOneSignal IDを取得
        const { data: threadData, error: threadError } = await supabase
            .from('threads')
            .select('onesignal_id')
            .eq('id', record.thread_id)
            .single()

        if (threadError || !threadData || !threadData.onesignal_id) {
            console.log("【スキップ】OneSignal IDが見つかりません:", threadError)
            return new Response("No target device found", { status: 200 })
        }

        console.log("【2. 送信対象取得】onesignal_id:", threadData.onesignal_id)

        // OneSignalに送る通知の内容を作成
        const payload = {
            app_id: ONESIGNAL_APP_ID,
            include_subscription_ids: [threadData.onesignal_id],
            headings: { ja: "Luca", en: "Luca" },
            contents: { ja: "メッセージが届きました！", en: "New message arrived!" },
            url: `${Deno.env.get('APP_URL')}/?id=${record.thread_id}` 
        }

        // OneSignalのAPIを叩いて、実際のプッシュ通知を発射！
        const response = await fetch("https://onesignal.com/api/v1/notifications", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify(payload)
        })

        const resText = await response.text()
        console.log("【3. OneSignalレスポンス】:", resText)

        return new Response(resText, { status: 200 })
    } catch (err) {
        console.error("【エラー発生】:", err)
        return new Response(String(err), { status: 500 })
    }
})