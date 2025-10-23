import { verifySignatureAppRouter } from "@upstash/qstash/nextjs"

export const POST = verifySignatureAppRouter(async (req: Request) => {
  const body = await req.json()

  console.log(body)

  return new Response(`Image with id processed successfully.`)
})