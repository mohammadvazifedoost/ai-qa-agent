import { defineConfig } from '@company/ai-qa';

export default defineConfig({
  project: {
    name: "demo-shop",
    framework: "vite",
    packageManager: "npm",
  },
  app: {
    baseUrl: "http://localhost:5173",
    startCommand: "npm run dev",
  },
  source: {
    include: ["src"],
  },
  ai: {
    model: 'sonnet',
    mcpServers: {
      playwright: {"command":"npx","args":["-y","@playwright/mcp@latest","--headless","--isolated"]},
    },
  },
});
