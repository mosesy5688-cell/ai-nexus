// functions/test.js - 仅用于诊断 POST 功能是否启用

export async function onRequest(context) {
    const { request } = context;

    // 强制日志，用于在 Cloudflare 实时日志中确认触发
    console.log("DIAGNOSTIC: Test Function Triggered at /test");
    console.log("DIAGNOSTIC: Method Received:", request.method);

    if (request.method === 'POST') {
        // 返回明确的 201 状态码，确认 POST 成功
        return new Response(JSON.stringify({ 
            message: "SUCCESS: POST method works on a root-level function." 
        }), { 
            status: 201, 
            headers: { 'Content-Type': 'application/json' }
        });
    } else {
        return new Response(`Function is running. Send POST to test. Current method: ${request.method}`, { 
            status: 200 
        });
    }
}