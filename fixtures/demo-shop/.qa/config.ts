import { defineConfig } from '@company/ai-qa-agent';

export default defineConfig({
  project: {
    name: "demo-shop",
    framework: "vite",
    packageManager: "npm",
  },
  app: {
    baseUrl: "http://127.0.0.1:5173",
    startCommand: "npm run dev",
  },
  source: {
    include: ["src"],
  },
  figma: {
    fileUrl: "https://www.figma.com/design/RPpqNkGynHaWPphAXkpFFH/ai-qa-demo-shop-design",
    // Optional: pin frames { name, nodeId, route, viewport }. Otherwise screens are discovered by `ai-qa-agent analyze`.
    frames: [],
  },
  clickup: {
    listId: "901523571090",
    tokenEnv: "CLICKUP_API_TOKEN",
    status: "to do",
  },
  ai: {
    model: 'sonnet',
    mcpServers: {
      figma: {"type":"http","url":"https://mcp.figma.com/mcp"},
      playwright: {"command":"npx","args":["-y","@playwright/mcp@latest","--headless","--isolated"]},
    },
  },
});
