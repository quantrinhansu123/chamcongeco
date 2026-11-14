import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// MediaPipe dynamically imports its WASM loader. Serve only these pinned public
// assets before Vite's source transform, which rejects public JS with ?import.
const visionAssets: Record<string, string> = {
  '/tasks-vision-1.2.3/vision_wasm_module_internal.js': 'application/javascript',
  '/tasks-vision-1.2.3/vision_wasm_module_internal.wasm': 'application/wasm',
  '/face-landmarker-64184e229b263107.task': 'application/octet-stream',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'self-hosted-vision-assets',
    configureServer(server) {
      server.middlewares.use('/vision', async (request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        const mime = visionAssets[path]
        if (!mime) return next()
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.statusCode = 405; response.end(); return }
        try {
          const bytes = await readFile(fileURLToPath(new URL(`./public/vision${path}`, import.meta.url)))
          response.setHeader('Content-Type', mime)
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          response.end(request.method === 'HEAD' ? undefined : bytes)
        } catch { response.statusCode = 404; response.end('Prepare vision assets with bun run prepare:vision') }
      })
    },
  }],
  worker: { format: 'es' },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8000' } } },
})
