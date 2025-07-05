# Use the official Bun image
FROM oven/bun:1.2.15

# Install ffmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get install -y gpac && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy only dependency files first for caching
COPY bun.lock package.json ./

# Install dependencies
RUN bun install

# Copy the rest of the application, including the src folder
COPY . .

# Expose port (adjust if different)
EXPOSE 3000

# Start the server — adjust the path if needed
CMD ["bun", "run", "src/index.ts"]
