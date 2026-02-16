# -----------------------------------------------------------------------------
# Base Image: Official Playwright image (Includes Node.js + Browsers)
# We use 'jammy' (Ubuntu 22.04) which is stable and widely supported.
# -----------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# 1. Set the working directory inside the container
WORKDIR /app

# 2. Copy package files first
# This allows Docker to cache the installation step if dependencies haven't changed
COPY package*.json ./

# 3. Install dependencies
# 'npm ci' is faster and stricter than 'npm install' for production
RUN npm ci

# 4. Copy the rest of the application code
COPY . .

# 5. Expose the port
# Render sets a PORT env var automatically, but this documents the intent
EXPOSE 3000

# 6. Start the server
CMD ["node", "server.js"]