FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
