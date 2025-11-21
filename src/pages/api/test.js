export const prerender = false;

export async function GET() {
    return new Response('Hello from API endpoint', {
        status: 200,
        headers: {
            'Content-Type': 'text/plain'
        }
    });
}
