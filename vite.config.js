import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/Vancity-Equity-Pulse/', // Ensure the slashes and Capitalization are EXACT
})